import { describe, expect, it } from "vitest";
import type {
  CostedTokens,
  GuiSettingsStore,
  HomeSnapshot,
  ImportPreview,
  JsonValue,
  ProjectSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
  SettingsWriteResult,
} from "../src/contracts/dashboard.js";
import type { RangeKey } from "../src/contracts/ranges.js";
import { planRangeBuckets, rangeBucketUnit, rangeWindow } from "../src/contracts/ranges.js";
import { GuiSettingsError } from "../src/gui/config.js";
import { createGuiLogger, GUI_LOG_PREFIX } from "../src/gui/log.js";
import { DashboardHttpError } from "../src/gui/server.js";
import type { SnapshotSource } from "../src/gui/snapshot-service.js";
import { startTestDashboardServer } from "./helpers/dashboard-server-test-harness.js";

const NOW = Date.parse("2026-10-18T10:30:00.000Z");

const FAKE_SECRET = "canary-secret-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OTAifQ.abcdefghijklmnopqrstuvwxyz0123456789";
const WIN_PATH = "C:\\Users\\alice\\AppData\\Roaming\\opencode\\auth.json";
const POSIX_PATH = "/home/alice/.local/share/opencode/auth.json";
const RAW_SOURCE_ID = "rai1_0123456789abcdef";
const MALICIOUS = `probe failed ${FAKE_SECRET} ${FAKE_JWT} ${WIN_PATH} ${POSIX_PATH} id=${RAW_SOURCE_ID}`;

const MARKERS = [FAKE_SECRET, FAKE_JWT, "alice", "auth.json", RAW_SOURCE_ID, "canary-secret"];

function expectNoMarkers(text: string): void {
  for (const marker of MARKERS) {
    expect(text).not.toContain(marker);
  }
}

function costed(total: number): CostedTokens {
  return {
    input: total,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function usageFor(range: RangeKey): HomeSnapshot["usage"] {
  return {
    range,
    window: rangeWindow(range, NOW),
    bucketUnit: rangeBucketUnit(range),
    timeZone: "UTC",
    buckets: planRangeBuckets(range, NOW).map((bucket) => ({ ...bucket, tokens: costed(0) })),
    totals: costed(0),
    stepCount: 0,
    sessionCount: 0,
    stale: false,
  };
}

function homeSnapshot(range: RangeKey): HomeSnapshot {
  return {
    generatedAtMs: NOW,
    range,
    stale: false,
    providers: { cards: [], enabledProviders: "auto", polledAtMs: NOW },
    usage: usageFor(range),
    projects: [],
  };
}

function projectSnapshot(projectId: string, range: RangeKey): ProjectSnapshot {
  return {
    projectId,
    name: "Project",
    range,
    window: rangeWindow(range, NOW),
    roots: [],
    totals: { ...costed(0), sessionCount: 0 },
    usage: usageFor(range),
    stale: false,
  };
}

function sessionSnapshot(sessionId: string): SessionSnapshot {
  return {
    focusSessionId: sessionId,
    projectId: "project-1",
    projectName: "Project",
    breadcrumbs: [],
    nodes: [],
    steps: [],
    compactionMarkers: [],
    ownSummary: { ...costed(0), stepCount: 0 },
    treeTotals: costed(0),
    stepSemantics: "one completed assistant message row is one step",
  };
}

function settingsPayload(): SettingsSnapshot {
  return {
    revision: "rev-1",
    pathLabel: "opencode-quota-gui/config.jsonc",
    values: {},
    sources: {},
    writable: [],
    dashboard: { port: 4144, url: "http://127.0.0.1:4144" },
    visibility: { hiddenCards: [], hiddenRows: [] },
    import: { available: false, issues: [] },
    issues: [],
  };
}

function importPreview(): ImportPreview {
  return { from: "", keys: [], issues: [], expectedRevision: "rev-1" };
}

function writeResult(): SettingsWriteResult {
  return { revision: "rev-2", applied: {}, warnings: [] };
}

interface PrivacyFixtures {
  logs: string[];
  source: SnapshotSource;
  store: GuiSettingsStore;
  storeBehavior: {
    onSave?: () => never;
    onVisibility?: () => never;
  };
}

function buildFixtures(): PrivacyFixtures {
  const logs: string[] = [];
  const storeBehavior: PrivacyFixtures["storeBehavior"] = {};
  const source: SnapshotSource = {
    home: async ({ range }) => homeSnapshot(range),
    project: async ({ projectId, range }) => {
      if (projectId === "missing") {
        throw Object.assign(new Error(MALICIOUS), { code: "project-not-found" });
      }
      return projectSnapshot(projectId, range);
    },
    session: async ({ sessionId }) => sessionSnapshot(sessionId),
  };
  const store: GuiSettingsStore = {
    settings: async () => settingsPayload(),
    saveSettings: async (input) => {
      if (storeBehavior.onSave) storeBehavior.onSave();
      if (input.patch.telemetry !== undefined) {
        throw new GuiSettingsError("unknown-setting", "Unknown setting", { key: WIN_PATH });
      }
      if (input.expectedRevision === "stale") {
        throw new GuiSettingsError("config-target-error", "Not writable", { reason: WIN_PATH });
      }
      return writeResult();
    },
    saveVisibility: async (input): Promise<SettingsWriteResult> => {
      if (storeBehavior.onVisibility) storeBehavior.onVisibility();
      return {
        revision: "rev-2",
        applied: {
          "dashboard.hiddenCards": input.hiddenCards,
          "dashboard.hiddenRows": input.hiddenRows,
        },
        warnings: [],
      };
    },
    importPreview: async () => importPreview(),
    importApply: async () => writeResult(),
  };
  return { logs, source, store, storeBehavior };
}

async function start(): Promise<{
  port: number;
  close: () => Promise<void>;
  fixtures: PrivacyFixtures;
}> {
  const fixtures = buildFixtures();
  const handle = await startTestDashboardServer({
    port: 0,
    source: fixtures.source,
    settings: fixtures.store,
    logger: createGuiLogger({ sink: (line) => fixtures.logs.push(line) }),
  });
  return { port: handle.port, close: () => handle.close(), fixtures };
}

function base(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function put(port: number, path: string, payload: JsonValue): Promise<Response> {
  return fetch(`${base(port)}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

interface ErrorDetails {
  key?: string;
  reason?: string;
}

interface ErrorEnvelope {
  error: { code: string; details?: ErrorDetails };
}

/** Parses an error envelope and proves its shape before narrowing the type. */
function parseErrorEnvelope(body: string): ErrorEnvelope {
  const parsed: unknown = JSON.parse(body);
  expect(parsed).toMatchObject({ error: { code: expect.any(String) } });
  // SAFETY: the `toMatchObject` proof above establishes `error.code`; `details`
  // is only read via optional access with an undefined expectation.
  return parsed as ErrorEnvelope;
}

describe("GUI server privacy", () => {
  it("maps unknown source exceptions to a generic 500 and never logs raw messages", async () => {
    const { port, close, fixtures } = await start();
    fixtures.source.home = async () => {
      throw new Error(MALICIOUS);
    };
    try {
      const response = await fetch(`${base(port)}/api/v1/home`);
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        error: { code: "internal", message: "Internal dashboard error" },
      });
      expectNoMarkers(body);

      expect(fixtures.logs.length).toBeGreaterThan(0);
      for (const line of fixtures.logs) {
        expect(line.startsWith(GUI_LOG_PREFIX)).toBe(true);
        expectNoMarkers(line);
      }
    } finally {
      await close();
    }
  });

  it("keeps known source error codes controlled without echoing raw data", async () => {
    const { port, close, fixtures } = await start();
    try {
      const response = await fetch(`${base(port)}/api/v1/projects/missing?range=7d`);
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        error: { code: "project-not-found", message: "Project not found" },
      });
      expectNoMarkers(body);

      expect(fixtures.logs).toHaveLength(1);
      expect(fixtures.logs[0]).toContain("project-not-found");
      expectNoMarkers(fixtures.logs[0] ?? "");

      const structured = Object.assign(new Error(MALICIOUS), { code: "session-not-found" });
      fixtures.source.session = async () => {
        throw structured;
      };
      const session = await fetch(`${base(port)}/api/v1/sessions/anything`);
      expect(session.status).toBe(404);
      const sessionBody = await session.text();
      expect(JSON.parse(sessionBody)).toEqual({
        error: { code: "session-not-found", message: "Session not found" },
      });
      expectNoMarkers(sessionBody);
    } finally {
      await close();
    }
  });

  it("does not serialize store exception messages or unvetted details", async () => {
    const { port, close, fixtures } = await start();
    try {
      fixtures.storeBehavior.onSave = () => {
        throw new GuiSettingsError("invalid-setting", MALICIOUS);
      };
      const invalid = await put(port, "/api/v1/settings", {
        patch: { minIntervalMs: 1 },
        expectedRevision: "rev-1",
      });
      expect(invalid.status).toBe(422);
      const invalidBody = await invalid.text();
      expect(JSON.parse(invalidBody)).toEqual({
        error: { code: "invalid-setting", message: "Invalid setting" },
      });
      expectNoMarkers(invalidBody);

      fixtures.storeBehavior.onSave = undefined;
      const unknown = await put(port, "/api/v1/settings", {
        patch: { telemetry: true },
        expectedRevision: "rev-1",
      });
      expect(unknown.status).toBe(422);
      const unknownBody = await unknown.text();
      const unknownEnvelope = parseErrorEnvelope(unknownBody);
      expect(unknownEnvelope.error.code).toBe("unknown-setting");
      expect(unknownEnvelope.error.details?.key).toBeUndefined();
      expectNoMarkers(unknownBody);

      const target = await put(port, "/api/v1/settings", {
        patch: { minIntervalMs: 1 },
        expectedRevision: "stale",
      });
      expect(target.status).toBe(409);
      const targetBody = await target.text();
      const targetEnvelope = parseErrorEnvelope(targetBody);
      expect(targetEnvelope.error.code).toBe("config-target-error");
      expect(targetEnvelope.error.details?.reason).toBeUndefined();
      expectNoMarkers(targetBody);

      fixtures.storeBehavior.onSave = () => {
        throw new GuiSettingsError("config-target-error", "Not writable", { reason: "dangling" });
      };
      const dangling = await put(port, "/api/v1/settings", {
        patch: { minIntervalMs: 1 },
        expectedRevision: "rev-1",
      });
      expect(dangling.status).toBe(409);
      const danglingEnvelope = parseErrorEnvelope(await dangling.text());
      expect(danglingEnvelope.error.details?.reason).toBe("dangling");

      fixtures.storeBehavior.onSave = () => {
        throw new GuiSettingsError("invalid-setting", "Invalid", { reason: "dangling" });
      };
      const nonTargetReason = await put(port, "/api/v1/settings", {
        patch: { minIntervalMs: 1 },
        expectedRevision: "rev-1",
      });
      expect(nonTargetReason.status).toBe(422);
      const nonTargetEnvelope = parseErrorEnvelope(await nonTargetReason.text());
      expect(nonTargetEnvelope.error.code).toBe("invalid-setting");
      expect(nonTargetEnvelope.error.details?.reason).toBeUndefined();

      for (const line of fixtures.logs) {
        expectNoMarkers(line);
      }
    } finally {
      await close();
    }
  });

  it("never echoes or logs request paths and query strings", async () => {
    const { port, close, fixtures } = await start();
    try {
      const invalidRange = await fetch(
        `${base(port)}/api/v1/home?range=${encodeURIComponent(MALICIOUS)}`,
      );
      expect(invalidRange.status).toBe(400);
      const rangeBody = await invalidRange.text();
      expect(JSON.parse(rangeBody)).toEqual({
        error: { code: "bad-request", message: "Malformed request" },
      });
      expectNoMarkers(rangeBody);

      const unknownRoute = await fetch(`${base(port)}/api/v1/${FAKE_SECRET}`);
      expect(unknownRoute.status).toBe(404);
      const routeBody = await unknownRoute.text();
      expectNoMarkers(routeBody);

      expect(fixtures.logs).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("keeps the allowed controlled error surface free of raw exception classes", async () => {
    const { port, close, fixtures } = await start();
    try {
      expect(new DashboardHttpError("project-not-found").message).toBe("Project not found");

      const response = await fetch(`${base(port)}/api/v1/health`);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        app: "opencode-quota-gui",
        contractVersion: 2,
        version: expect.any(String),
        build: expect.any(String),
      });
      expectNoMarkers(body);

      const settings = await fetch(`${base(port)}/api/v1/settings`);
      const settingsBody = await settings.text();
      expectNoMarkers(settingsBody);
      expect(fixtures.logs).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
