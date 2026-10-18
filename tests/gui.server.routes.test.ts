import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { createGuiLogger } from "../src/gui/log.js";
import {
  createDashboardServer,
  DashboardHttpError,
  type DashboardServerHandle,
} from "../src/gui/server.js";
import type { SnapshotSource } from "../src/gui/snapshot-service.js";

const NOW = Date.parse("2026-10-18T10:30:00.000Z");
const INDEX_HTML = '<!doctype html><html><body><div id="app"></div></body></html>';

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

function usageFor(range: RangeKey, total: number): HomeSnapshot["usage"] {
  return {
    range,
    window: rangeWindow(range, NOW),
    bucketUnit: rangeBucketUnit(range),
    buckets: planRangeBuckets(range, NOW).map((bucket) => ({ ...bucket, tokens: costed(0) })),
    totals: costed(total),
    stepCount: 1,
    sessionCount: 1,
    stale: false,
  };
}

function homeSnapshot(range: RangeKey): HomeSnapshot {
  return {
    generatedAtMs: NOW,
    range,
    stale: false,
    providers: { cards: [], enabledProviders: "auto", polledAtMs: NOW },
    usage: usageFor(range, 10),
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
    usage: usageFor(range, 0),
    stale: false,
  };
}

function sessionSnapshot(sessionId: string): SessionSnapshot {
  return {
    focusSessionId: sessionId,
    breadcrumbs: [{ sessionId, title: "Root", isFocus: true }],
    nodes: [],
    steps: [],
    compactionMarkers: [],
    ownSummary: { ...costed(0), stepCount: 0 },
    treeTotals: costed(0),
    stepSemantics: "one completed assistant message row is one step",
  };
}

interface RouteFixtures {
  state: {
    homeRanges: RangeKey[];
    projectRanges: RangeKey[];
    lastSettingsInput?: { patch: Record<string, JsonValue>; expectedRevision: string };
    lastVisibilityInput?: {
      hiddenCards: string[];
      hiddenRows: string[];
      expectedRevision: string;
    };
    lastImportInput?: { expectedRevision: string };
  };
  source: SnapshotSource;
  store: GuiSettingsStore;
}

function buildFixtures(): RouteFixtures {
  const state: RouteFixtures["state"] = { homeRanges: [], projectRanges: [] };
  const source: SnapshotSource = {
    home: async ({ range }) => {
      state.homeRanges.push(range);
      return homeSnapshot(range);
    },
    project: async ({ projectId, range }) => {
      state.projectRanges.push(range);
      if (projectId === "missing") throw new DashboardHttpError("project-not-found");
      return projectSnapshot(projectId, range);
    },
    session: async ({ sessionId }) => {
      if (sessionId === "missing") throw new DashboardHttpError("session-not-found");
      return sessionSnapshot(sessionId);
    },
  };
  const settingsPayload: SettingsSnapshot = {
    revision: "rev-1",
    pathLabel: "opencode-quota-gui/config.jsonc",
    values: { minIntervalMs: 300000 },
    sources: { minIntervalMs: "defaults" },
    writable: ["minIntervalMs"],
    dashboard: { port: 4144, url: "http://127.0.0.1:4144" },
    visibility: { hiddenCards: [], hiddenRows: [] },
    import: { available: true, from: "global opencode.jsonc", keyCount: 1, issues: [] },
    issues: [],
  };
  const store: GuiSettingsStore = {
    settings: async () => settingsPayload,
    saveSettings: async (input) => {
      if (input.patch.telemetry !== undefined) {
        throw new GuiSettingsError("unknown-setting", "Unknown setting", { key: "telemetry" });
      }
      if (input.expectedRevision === "stale") {
        throw new GuiSettingsError("config-changed", "Config changed");
      }
      state.lastSettingsInput = input;
      return { revision: "rev-2", applied: input.patch, warnings: [] };
    },
    saveVisibility: async (input) => {
      state.lastVisibilityInput = input;
      return {
        revision: "rev-2",
        applied: {
          "dashboard.hiddenCards": input.hiddenCards,
          "dashboard.hiddenRows": input.hiddenRows,
        },
        warnings: [],
      };
    },
    importPreview: async (): Promise<ImportPreview> => ({
      from: "global opencode.jsonc (experimental.quotaToast)",
      keys: [{ key: "minIntervalMs", value: 60000 }],
      issues: [],
      expectedRevision: "rev-1",
    }),
    importApply: async (input): Promise<SettingsWriteResult> => {
      state.lastImportInput = input;
      return { revision: "rev-2", applied: {}, warnings: [] };
    },
  };
  return { state, source, store };
}

interface Running {
  handle: DashboardServerHandle;
  state: RouteFixtures["state"];
}

let assetRoot = "";

beforeAll(async () => {
  assetRoot = await mkdtemp(join(tmpdir(), "gui-p4-routes-"));
  await mkdir(join(assetRoot, "assets"), { recursive: true });
  await writeFile(join(assetRoot, "index.html"), INDEX_HTML);
  await writeFile(join(assetRoot, "assets", "app.js"), "console.log('app');");
  await writeFile(join(assetRoot, "assets", "styles.css"), "body { color: #000; }");
  await writeFile(
    join(assetRoot, "assets", "logo.svg"),
    "<svg xmlns='http://www.w3.org/2000/svg'/>",
  );
  await writeFile(join(assetRoot, "assets", "font.woff2"), "wOF2");
  await writeFile(join(assetRoot, "assets", "font.woff"), "wOFF");
  await writeFile(join(assetRoot, "assets", "font.ttf"), "TrueType");
  await writeFile(join(assetRoot, "assets", "notes.txt"), "not an asset");
});

afterAll(async () => {
  if (assetRoot) await rm(assetRoot, { recursive: true, force: true });
});

async function start(): Promise<Running> {
  const { state, source, store } = buildFixtures();
  const handle = await createDashboardServer({
    port: 0,
    source,
    settings: store,
    assetRoot,
    logger: createGuiLogger({ sink: () => {} }),
  });
  return { handle, state };
}

function base(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function get(
  port: number,
  path: string,
): Promise<{ status: number; headers: Headers; body: JsonValue | undefined }> {
  const response = await fetch(`${base(port)}${path}`);
  const text = await response.text();
  let body: JsonValue | undefined;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}

function put(port: number, path: string, payload: JsonValue): Promise<Response> {
  return fetch(`${base(port)}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function post(port: number, path: string, payload: JsonValue): Promise<Response> {
  return fetch(`${base(port)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function errorOf(body: JsonValue | undefined): { code: string; message: string } {
  expect(body).toMatchObject({
    error: { code: expect.any(String), message: expect.any(String) },
  });
  // SAFETY: the `toMatchObject` proof above establishes the envelope shape,
  // including string `code` and `message`.
  const { error } = body as { error: { code: string; message: string } };
  return error;
}

describe("GUI HTTP routes", () => {
  it("serves health with the frozen app id and contract version", async () => {
    const { handle } = await start();
    try {
      const response = await get(handle.port, "/api/v1/health");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ app: "opencode-quota-gui", contractVersion: 1 });
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await handle.close();
    }
  });

  it("serves index.html at / and packaged assets under /assets", async () => {
    const { handle } = await start();
    try {
      const index = await fetch(`${base(handle.port)}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(await index.text()).toBe(INDEX_HTML);

      const js = await fetch(`${base(handle.port)}/assets/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("text/javascript");
      expect(await js.text()).toContain("console.log");

      const font = await fetch(`${base(handle.port)}/assets/font.woff2`);
      expect(font.status).toBe(200);
      expect(font.headers.get("content-type")).toContain("font/woff2");
      expect(font.headers.get("x-content-type-options")).toBe("nosniff");

      // The actual UI build emits .woff and .ttf fallbacks too; each must be
      // served with its own MIME type (packaged local fonts, never external).
      const woff = await fetch(`${base(handle.port)}/assets/font.woff`);
      expect(woff.status).toBe(200);
      expect(woff.headers.get("content-type")).toBe("font/woff");
      expect(woff.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await woff.text()).toBe("wOFF");

      const ttf = await fetch(`${base(handle.port)}/assets/font.ttf`);
      expect(ttf.status).toBe(200);
      expect(ttf.headers.get("content-type")).toBe("font/ttf");
      expect(ttf.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await ttf.text()).toBe("TrueType");

      const head = await fetch(`${base(handle.port)}/`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
      expect(await head.text()).toBe("");

      const missing = await fetch(`${base(handle.port)}/assets/nope.js`);
      expect(missing.status).toBe(404);
      expect(errorOf(await missing.json()).code).toBe("not-found");

      const notAllowlisted = await fetch(`${base(handle.port)}/assets/notes.txt`);
      expect(notAllowlisted.status).toBe(404);

      // The newly allowed font extensions must not weaken the path guard.
      const traversal = await fetch(`${base(handle.port)}/assets/%2e%2e%2ffont.woff`);
      expect([400, 404]).toContain(traversal.status);
    } finally {
      await handle.close();
    }
  });

  it("passes the range through with the 7d default and rejects invalid ranges", async () => {
    const { handle, state } = await start();
    try {
      await get(handle.port, "/api/v1/home");
      await get(handle.port, "/api/v1/home?range=24h");
      await get(handle.port, "/api/v1/projects/p1");
      await get(handle.port, "/api/v1/projects/p1?range=lifetime");
      expect(state.homeRanges).toEqual(["7d", "24h"]);
      expect(state.projectRanges).toEqual(["7d", "lifetime"]);

      const invalid = await get(handle.port, "/api/v1/home?range=1d");
      expect(invalid.status).toBe(400);
      expect(errorOf(invalid.body).code).toBe("bad-request");
    } finally {
      await handle.close();
    }
  });

  it("serves project and session snapshots and maps unknown ids", async () => {
    const { handle } = await start();
    try {
      const project = await get(handle.port, "/api/v1/projects/p1?range=7d");
      expect(project.status).toBe(200);
      expect(project.body).toMatchObject({ projectId: "p1" });

      const session = await get(handle.port, "/api/v1/sessions/s1");
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({ focusSessionId: "s1" });

      const missingProject = await get(handle.port, "/api/v1/projects/missing?range=7d");
      expect(missingProject.status).toBe(404);
      expect(errorOf(missingProject.body)).toEqual({
        code: "project-not-found",
        message: "Project not found",
      });

      const missingSession = await get(handle.port, "/api/v1/sessions/missing");
      expect(missingSession.status).toBe(404);
      expect(errorOf(missingSession.body).code).toBe("session-not-found");
    } finally {
      await handle.close();
    }
  });

  it("serves settings and applies revision-checked writes", async () => {
    const { handle, state } = await start();
    try {
      const settings = await get(handle.port, "/api/v1/settings");
      expect(settings.status).toBe(200);
      expect(settings.body).toMatchObject({ revision: "rev-1" });

      const preview = await get(handle.port, "/api/v1/settings/import");
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ expectedRevision: "rev-1" });

      const save = await put(handle.port, "/api/v1/settings", {
        patch: { minIntervalMs: 60000 },
        expectedRevision: "rev-1",
      });
      expect(save.status).toBe(200);
      expect(state.lastSettingsInput).toEqual({
        patch: { minIntervalMs: 60000 },
        expectedRevision: "rev-1",
      });
      expect(await save.json()).toMatchObject({ revision: "rev-2" });

      const visibility = await put(handle.port, "/api/v1/visibility", {
        hiddenCards: ["card-1"],
        hiddenRows: [],
        expectedRevision: "rev-1",
      });
      expect(visibility.status).toBe(200);
      expect(state.lastVisibilityInput).toEqual({
        hiddenCards: ["card-1"],
        hiddenRows: [],
        expectedRevision: "rev-1",
      });

      const applied = await post(handle.port, "/api/v1/settings/import", {
        expectedRevision: "rev-1",
      });
      expect(applied.status).toBe(200);
      expect(state.lastImportInput).toEqual({ expectedRevision: "rev-1" });
    } finally {
      await handle.close();
    }
  });

  it("maps settings store errors to the controlled envelope", async () => {
    const { handle } = await start();
    try {
      const unknown = await put(handle.port, "/api/v1/settings", {
        patch: { telemetry: true },
        expectedRevision: "rev-1",
      });
      expect(unknown.status).toBe(422);
      expect(errorOf(await unknown.json()).code).toBe("unknown-setting");

      const stale = await put(handle.port, "/api/v1/settings", {
        patch: { minIntervalMs: 60000 },
        expectedRevision: "stale",
      });
      expect(stale.status).toBe(409);
      expect(errorOf(await stale.json()).code).toBe("config-changed");
    } finally {
      await handle.close();
    }
  });

  it("rejects malformed write bodies with bad-request", async () => {
    const { handle } = await start();
    try {
      const notJson = await fetch(`${base(handle.port)}/api/v1/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(notJson.status).toBe(400);
      expect(errorOf(await notJson.json()).code).toBe("bad-request");

      const unknownKey = await put(handle.port, "/api/v1/settings", {
        patch: { minIntervalMs: 60000 },
        expectedRevision: "rev-1",
        extra: true,
      });
      expect(unknownKey.status).toBe(400);

      const badPatch = await put(handle.port, "/api/v1/settings", {
        patch: "not-an-object",
        expectedRevision: "rev-1",
      });
      expect(badPatch.status).toBe(400);

      const badVisibility = await put(handle.port, "/api/v1/visibility", {
        hiddenCards: "not-an-array",
        hiddenRows: [],
        expectedRevision: "rev-1",
      });
      expect(badVisibility.status).toBe(400);

      const badImport = await post(handle.port, "/api/v1/settings/import", {});
      expect(badImport.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it("caps the write body at 64 KiB", async () => {
    const { handle } = await start();
    try {
      const response = await post(handle.port, "/api/v1/settings/import", {
        expectedRevision: "rev-1",
        pad: "a".repeat(70_000),
      });
      expect(response.status).toBe(413);
      expect(errorOf(await response.json()).code).toBe("body-too-large");
    } finally {
      await handle.close();
    }
  });

  it("answers 405 with Allow for known paths and 404 for unknown ones", async () => {
    const { handle } = await start();
    try {
      const postHome = await post(handle.port, "/api/v1/home", {});
      expect(postHome.status).toBe(405);
      expect(postHome.headers.get("allow") ?? "").toContain("GET");

      const deleteSettings = await fetch(`${base(handle.port)}/api/v1/settings`, {
        method: "DELETE",
      });
      expect(deleteSettings.status).toBe(405);
      const allow = deleteSettings.headers.get("allow") ?? "";
      expect(allow).toContain("GET");
      expect(allow).toContain("PUT");

      const postEvents = await post(handle.port, "/api/v1/events", {});
      expect(postEvents.status).toBe(405);
      expect(postEvents.headers.get("allow") ?? "").toContain("GET");

      const unknown = await get(handle.port, "/api/v1/nope");
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown.body).code).toBe("not-found");
    } finally {
      await handle.close();
    }
  });
});
