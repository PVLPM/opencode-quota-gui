/**
 * Storage-agnostic helpers for the Analytics benchmark. The same suite runs
 * against a JSON-index build (`analytics-v3.json` + presentation sidecar) and
 * a SQLite-index build (`analytics.sqlite` beside it), so footprint, isolated
 * copies, clock aging and write volume never assume one layout.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { DAY_MS, openDatabase } from "./analytics-benchmark-fixtures.mjs";

/** Mirrors `analyticsStorePathFor` without importing either build. */
export function sqliteStorePath(snapshotPath) {
  return basename(snapshotPath) === "analytics-v3.json"
    ? join(dirname(snapshotPath), "analytics.sqlite")
    : `${snapshotPath}.sqlite`;
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Bytes on disk per artifact; `indexBytes` is whichever index layout exists. */
export function storageFootprint(snapshotPath) {
  const sqlite = sqliteStorePath(snapshotPath);
  const footprint = {
    backend: "none",
    jsonIndexBytes: sizeOf(snapshotPath),
    jsonPresentationBytes: sizeOf(`${snapshotPath}.presentation.json`),
    sqliteBytes: sizeOf(sqlite),
    sqliteWalBytes: sizeOf(`${sqlite}-wal`),
    sqliteShmBytes: sizeOf(`${sqlite}-shm`),
  };
  if (footprint.sqliteBytes > 0) footprint.backend = "sqlite";
  else if (footprint.jsonIndexBytes > 0) footprint.backend = "json";
  footprint.indexBytes =
    footprint.backend === "sqlite" ? footprint.sqliteBytes : footprint.jsonIndexBytes;
  footprint.totalBytes =
    footprint.jsonIndexBytes +
    footprint.jsonPresentationBytes +
    footprint.sqliteBytes +
    footprint.sqliteWalBytes +
    footprint.sqliteShmBytes;
  return footprint;
}

/**
 * Copy only the compact index (never the warm presentation) to a fresh
 * location, so a restart there is a cold resume on either backend.
 */
export async function copyIndexOnly(fromSnapshotPath, toSnapshotPath) {
  mkdirSync(dirname(toSnapshotPath), { recursive: true });
  const from = sqliteStorePath(fromSnapshotPath);
  if (existsSync(from)) {
    const to = sqliteStorePath(toSnapshotPath);
    copyFileSync(from, to);
    if (existsSync(`${from}-wal`)) copyFileSync(`${from}-wal`, `${to}-wal`);
    const db = await openDatabase(to);
    try {
      db.exec("DELETE FROM analytics_presentation");
      db.exec("DELETE FROM analytics_meta WHERE key = 'presentation.header'");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    return "sqlite";
  }
  if (existsSync(fromSnapshotPath)) {
    copyFileSync(fromSnapshotPath, toSnapshotPath);
    return "json";
  }
  return "none";
}

function shiftClock(value, shiftMs) {
  return typeof value === "number" ? Math.max(0, value - shiftMs) : undefined;
}

/** Age only the isolated index's cursor clocks to simulate a pause. */
export async function ageIndexClocks(snapshotPath, days) {
  const shiftMs = days * DAY_MS;
  const result = {
    sourceCursorShifted: false,
    repairClockShifted: false,
    agedSourceCursorAtMs: null,
  };
  const sqlite = sqliteStorePath(snapshotPath);
  if (existsSync(sqlite)) {
    const db = await openDatabase(sqlite);
    try {
      const read = (key) => {
        const row = db.prepare("SELECT value FROM analytics_meta WHERE key = ?").get(key);
        return row ? Number(row.value) : undefined;
      };
      const write = db.prepare("UPDATE analytics_meta SET value = ? WHERE key = ?");
      const cursor = shiftClock(read("index.sourceCursorAt"), shiftMs);
      if (cursor !== undefined) {
        write.run(String(cursor), "index.sourceCursorAt");
        result.sourceCursorShifted = true;
        result.agedSourceCursorAtMs = cursor;
      }
      const repair = shiftClock(read("index.lastFullRepairAt"), shiftMs);
      if (repair !== undefined) {
        write.run(String(repair), "index.lastFullRepairAt");
        result.repairClockShifted = true;
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    return result;
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const cursor = shiftClock(snapshot.sourceCursorAtMs, shiftMs);
  if (cursor !== undefined) {
    snapshot.sourceCursorAtMs = cursor;
    result.sourceCursorShifted = true;
    result.agedSourceCursorAtMs = cursor;
  }
  const repair = shiftClock(snapshot.lastFullRepairAtMs, shiftMs);
  if (repair !== undefined) {
    snapshot.lastFullRepairAtMs = repair;
    result.repairClockShifted = true;
  }
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  return result;
}

/**
 * Bytes this process has written through the OS so far (every file, the
 * worker thread included), or null where the platform exposes no counter.
 * Deltas around a phase measure persistence write volume for either backend.
 */
export function processWriteBytes() {
  if (process.platform === "linux") {
    try {
      const match = /^write_bytes:\s*(\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"));
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const query = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").WriteTransferCount`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    const value = Number(query.stdout?.trim());
    return query.status === 0 && Number.isFinite(value) ? value : null;
  }
  return null;
}
