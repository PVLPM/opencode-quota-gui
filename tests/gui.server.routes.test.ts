import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAnalyticsEntityToken } from "../src/contracts/analytics-entity.js";
import type {
  AnalyticsGroupQuery,
  AnalyticsGroupSnapshot,
  CostedTokens,
  GuiSettingsStore,
  HomeSnapshot,
  ImportPreview,
  JsonValue,
  ProjectSnapshot,
  QuotaSnapshot,
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
    timeZone: "UTC",
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

function quotaSnapshot(): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: false,
    providers: { cards: [], enabledProviders: "auto", polledAtMs: NOW },
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
    projectId: "project-1",
    projectName: "Project",
    breadcrumbs: [{ sessionId, title: "Root", isFocus: true }],
    nodes: [],
    steps: [],
    compactionMarkers: [],
    ownSummary: { ...costed(0), stepCount: 0 },
    treeTotals: costed(0),
    stepSemantics: "one completed assistant message row is one step",
  };
}

function groupSnapshot(query: AnalyticsGroupQuery): AnalyticsGroupSnapshot {
  return {
    dimension: query.dimension,
    range: query.range,
    window: rangeWindow(query.range, NOW),
    bucketUnit: rangeBucketUnit(query.range),
    timeZone: "UTC",
    ...(query.filter === undefined ? {} : { filter: query.filter }),
    buckets: planRangeBuckets(query.range, NOW).map((bucket) => ({ ...bucket })),
    totals: costed(3),
    sessionCount: 1,
    stepCount: 1,
    rows: [
      {
        identity: { kind: "known", id: "gpt-5" },
        tokens: costed(3),
        sessionCount: 1,
        stepCount: 1,
        children: [],
      },
    ],
    series: [],
    stale: false,
  };
}

interface RouteFixtures {
  state: {
    homeRanges: RangeKey[];
    quotaCalls: number;
    projectRanges: RangeKey[];
    groupQueries: AnalyticsGroupQuery[];
    lastSettingsInput?: { patch: Record<string, JsonValue>; expectedRevision: string };
    lastVisibilityInput?: {
      hiddenCards: string[];
      hiddenRows: string[];
      expectedRevision: string;
    };
    lastImportInput?: { expectedRevision: string };
    openCalls: number;
  };
  source: SnapshotSource;
  store: GuiSettingsStore;
}

function buildFixtures(): RouteFixtures {
  const state: RouteFixtures["state"] = {
    homeRanges: [],
    quotaCalls: 0,
    projectRanges: [],
    groupQueries: [],
    openCalls: 0,
  };
  const source: SnapshotSource = {
    home: async ({ range }) => {
      state.homeRanges.push(range);
      return homeSnapshot(range);
    },
    quota: async () => {
      state.quotaCalls += 1;
      return quotaSnapshot();
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
    groups: async (query) => {
      state.groupQueries.push(query);
      return groupSnapshot(query);
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
    openSettingsFile: async () => {
      state.openCalls += 1;
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
  it.each([
    "/assets/../quota",
    "/project/%2e%2e/quota",
    "/model/../quota",
    "/provider/%2e%2e/quota",
    "/assets\\..\\quota",
  ])("does not normalize raw traversal %s into a shell request", async (path) => {
    const { handle } = await start();
    try {
      const result = await new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          const req = request(`${base(handle.port)}/`, { path }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode, body }));
          });
          req.on("error", reject);
          req.end();
        },
      );
      expect(result.status).toBe(404);
      expect(result.body).not.toBe(INDEX_HTML);
    } finally {
      await handle.close();
    }
  });

  it.each([
    "/quota",
    "/analytics?range=7d",
    "/project/a%20b?range=30d",
    "/project/a%2Fb?range=7d",
    "/session/ses%201",
    "/settings",
  ])("serves the shell on direct navigation and HEAD to %s without analytics work", async (path) => {
    const { handle, state } = await start();
    try {
      const response = await get(handle.port, path);
      expect(response.status).toBe(200);
      expect(response.body).toBe(INDEX_HTML);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      const head = await fetch(`${base(handle.port)}${path}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(state.homeRanges).toEqual([]);
      expect(state.projectRanges).toEqual([]);
      const post = await fetch(`${base(handle.port)}${path}`, { method: "POST" });
      expect(post.status).toBe(405);
    } finally {
      await handle.close();
    }
  });

  it.each([
    ["models overview", "/models"],
    ["models overview with range", "/models?range=30d"],
    [
      "known model detail",
      `/model/${encodeAnalyticsEntityToken({ kind: "known", id: "gpt-5" })}?range=7d`,
    ],
    ["unknown model detail", "/model/u?range=7d"],
    [
      "known-empty model detail",
      `/model/${encodeAnalyticsEntityToken({ kind: "known", id: "" })}?range=24h`,
    ],
    [
      "special-character provider detail",
      `/provider/${encodeAnalyticsEntityToken({
        kind: "known",
        id: "a/b?c#d %\0\uD800\u00e9",
      })}?range=lifetime`,
    ],
  ])("serves the shell for %s without analytics work", async (_label, path) => {
    const { handle, state } = await start();
    try {
      const response = await get(handle.port, path);
      expect(response.status).toBe(200);
      expect(response.body).toBe(INDEX_HTML);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      const head = await fetch(`${base(handle.port)}${path}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const post = await fetch(`${base(handle.port)}${path}`, { method: "POST" });
      expect(post.status).toBe(405);
      // Direct navigation serves the shell only; grouped API work is browser-driven.
      expect(state.groupQueries).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it.each([
    "/api/analytics",
    "/api/v1/nope",
    "/assets/nope.js",
    "/assets/nope.css",
    "/assets/app.js.map",
    "/assets/notes.txt",
    "/quota.js",
    "/analytics.css",
    "/project/",
    "/session/",
    "/project/a/extra",
    "/session/a/extra",
    "/settings/extra",
    "/project/%ZZ",
    "/session/%00",
    "/project/%2E%2E%2Fquota",
    "/session/a%5Cb",
    "/project/a.js",
    "/project/.js",
    "/project/a.js%2F",
    "/session/.js",
    "/session/a.js%2F",
    "/session/a.css",
    "/project/a.map",
    `/project/${"a".repeat(257)}`,
    "/project//a",
    "/quota/",
    "/assets/%2e%2e%2fquota",
  ])("does not return the shell for invalid or reserved path %s", async (path) => {
    const { handle } = await start();
    try {
      const response = await get(handle.port, path);
      expect([400, 404]).toContain(response.status);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.body).not.toBe(INDEX_HTML);
    } finally {
      await handle.close();
    }
  });

  it.each([
    "/model",
    "/provider",
    "/model/",
    "/provider/",
    "/model/u.",
    "/provider/u.",
    "/model/x",
    "/provider/not-a-token",
    "/model/k.!!!",
    "/model/k.a",
    "/model/k.ZwBwAHQALQA1AA.js",
    `/model/${encodeAnalyticsEntityToken({ kind: "known", id: "gpt-5" })}/extra`,
    `/provider/${encodeAnalyticsEntityToken({ kind: "known", id: "anthropic" })}/assets/app.js`,
    "/model/%ZZ",
    "/provider/%ZZ",
    "/model/%00",
    "/provider/%00",
    "/model/%2e%2e%2fquota",
    "/provider/%2e%2e%2fmodel",
    "/models/extra",
    "/models/",
    "/models.js",
    "/model/u/",
    "/provider/u/",
    "/provider/a.js",
  ])("does not return the shell for invalid analytics path %s", async (path) => {
    const { handle, state } = await start();
    try {
      const response = await get(handle.port, path);
      expect([400, 404]).toContain(response.status);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.body).not.toBe(INDEX_HTML);
      expect(state.groupQueries).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it("serves health with the frozen app id and contract version", async () => {
    const { handle } = await start();
    try {
      const response = await get(handle.port, "/api/v1/health");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        app: "opencode-quota-gui",
        contractVersion: 2,
        version: expect.any(String),
        build: expect.any(String),
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await handle.close();
    }
  });

  it("serves the independent quota snapshot without coupling it to home", async () => {
    const { handle, state } = await start();
    try {
      const home = await get(handle.port, "/api/v1/home");
      expect(home.status).toBe(200);
      expect(home.body).toMatchObject({
        providers: { cards: [], enabledProviders: "auto" },
      });
      expect(state.quotaCalls).toBe(0);

      const quota = await get(handle.port, "/api/v1/quota");
      expect(quota.status).toBe(200);
      expect(quota.body).toEqual(quotaSnapshot());
      expect(state.quotaCalls).toBe(1);

      const head = await fetch(`${base(handle.port)}/api/v1/quota`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    } finally {
      await handle.close();
    }
  });

  it("serves grouped model/provider reads through route-specific APIs", async () => {
    const { handle, state } = await start();
    try {
      const models = await get(handle.port, "/api/v1/models?range=24h");
      expect(models.status).toBe(200);
      expect(models.body).toMatchObject({ dimension: "model", range: "24h" });
      expect(state.groupQueries).toEqual([{ range: "24h", dimension: "model" }]);

      const providers = await get(handle.port, "/api/v1/providers");
      expect(providers.status).toBe(200);
      expect(providers.body).toMatchObject({ dimension: "provider", range: "7d" });
      expect(state.groupQueries.at(-1)).toEqual({ range: "7d", dimension: "provider" });

      const head = await fetch(`${base(handle.port)}/api/v1/models?range=30d`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");

      const invalidRange = await get(handle.port, "/api/v1/providers?range=1d");
      expect(invalidRange.status).toBe(400);
      expect(errorOf(invalidRange.body).code).toBe("bad-request");
      expect(state.groupQueries).toHaveLength(3);
    } finally {
      await handle.close();
    }
  });

  it("round-trips exact tagged model/provider identities through detail routes", async () => {
    const { handle, state } = await start();
    const ids = [
      "",
      "padded ",
      "a/b",
      "100%",
      "what?",
      "a#b",
      "a|||b",
      "unknown",
      "assets/app.js",
      "C:\\dir\\file.js",
      "模型/🤖",
    ];
    try {
      for (const id of ids) {
        const token = encodeAnalyticsEntityToken({ kind: "known", id });
        const modelDetail = await get(handle.port, `/api/v1/models/${token}?range=7d`);
        expect(modelDetail.status).toBe(200);
        expect(state.groupQueries.at(-1)).toEqual({
          range: "7d",
          dimension: "provider",
          filter: { dimension: "model", identity: { kind: "known", id } },
        });
        expect(modelDetail.body).toMatchObject({
          dimension: "provider",
          filter: { dimension: "model", identity: { kind: "known", id } },
        });

        const providerDetail = await get(handle.port, `/api/v1/providers/${token}?range=30d`);
        expect(providerDetail.status).toBe(200);
        expect(state.groupQueries.at(-1)).toEqual({
          range: "30d",
          dimension: "model",
          filter: { dimension: "provider", identity: { kind: "known", id } },
        });
      }

      const unknown = await get(handle.port, "/api/v1/models/u?range=24h");
      expect(unknown.status).toBe(200);
      expect(state.groupQueries.at(-1)).toEqual({
        range: "24h",
        dimension: "provider",
        filter: { dimension: "model", identity: { kind: "unknown" } },
      });

      const sameAxisToken = encodeAnalyticsEntityToken({ kind: "known", id: "gpt-5" });
      const sameAxis = await get(
        handle.port,
        `/api/v1/models/${sameAxisToken}?range=7d&group=model`,
      );
      expect(sameAxis.status).toBe(200);
      expect(state.groupQueries.at(-1)).toEqual({
        range: "7d",
        dimension: "model",
        filter: { dimension: "model", identity: { kind: "known", id: "gpt-5" } },
      });

      const malformedGroup = await get(handle.port, `/api/v1/models/${sameAxisToken}?group=tool`);
      expect(malformedGroup.status).toBe(400);
      expect(errorOf(malformedGroup.body).code).toBe("bad-request");
    } finally {
      await handle.close();
    }
  });

  it("rejects malformed group routes and keeps quota independent", async () => {
    const { handle, state } = await start();
    try {
      for (const path of [
        "/api/v1/models/k.!!!",
        "/api/v1/models/k.a",
        "/api/v1/models/x",
        "/api/v1/models/u.",
      ]) {
        const response = await get(handle.port, path);
        expect(response.status).toBe(400);
        expect(errorOf(response.body).code).toBe("bad-request");
      }
      expect(state.groupQueries).toEqual([]);

      for (const path of [
        "/api/v1/models/u/extra",
        "/api/v1/providers/u/extra",
        "/api/v1/providers/%ZZ",
        "/api/v1/missing",
      ]) {
        const response = await get(handle.port, path);
        expect(response.status).toBe(404);
        expect(errorOf(response.body).code).toBe("not-found");
      }

      const wrongMethod = await post(handle.port, "/api/v1/models", {});
      expect(wrongMethod.status).toBe(405);
      expect(errorOf(await wrongMethod.json()).code).toBe("method-not-allowed");

      await get(handle.port, "/api/v1/models?range=7d");
      expect(state.quotaCalls).toBe(0);
      await get(handle.port, "/api/v1/quota");
      expect(state.quotaCalls).toBe(1);
      expect(state.groupQueries).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it("closes the optional source on final close and on bind failure", async () => {
    const logger = createGuiLogger({ sink: () => {} });
    let closes = 0;
    const { source, store } = buildFixtures();
    const tracked: SnapshotSource = {
      ...source,
      close: async () => {
        closes += 1;
      },
    };
    const handle = await createDashboardServer({
      port: 0,
      source: tracked,
      settings: store,
      assetRoot,
      logger,
    });
    await handle.close();
    await handle.close();
    expect(closes).toBe(1);

    // A terminal bind failure releases source resources even though no handle
    // is returned.
    const occupied = await start();
    let bindCloses = 0;
    const failing = buildFixtures();
    const failingSource: SnapshotSource = {
      ...failing.source,
      close: async () => {
        bindCloses += 1;
      },
    };
    await expect(
      createDashboardServer({
        port: occupied.handle.port,
        source: failingSource,
        settings: failing.store,
        assetRoot,
        logger,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    for (let index = 0; index < 50 && bindCloses === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(bindCloses).toBe(1);
    await occupied.handle.close();
  });

  it("still closes when the source close itself fails", async () => {
    const logger = createGuiLogger({ sink: () => {} });
    const { source, store } = buildFixtures();
    const failing: SnapshotSource = {
      ...source,
      close: async () => {
        throw new Error("source close failed");
      },
    };
    const handle = await createDashboardServer({
      port: 0,
      source: failing,
      settings: store,
      assetRoot,
      logger,
    });
    await expect(handle.close()).resolves.toBeUndefined();
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

  it("retries a missing asset root instead of caching the miss", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gui-p4-late-root-"));
    const lateRoot = join(parent, "ui");
    const { source, store } = buildFixtures();
    const handle = await createDashboardServer({
      port: 0,
      source,
      settings: store,
      assetRoot: lateRoot,
      logger: createGuiLogger({ sink: () => {} }),
    });
    try {
      const missing = await fetch(`${base(handle.port)}/`);
      expect(missing.status).toBe(404);

      // `dist/ui` may be produced while the dashboard is already running; the
      // next request must observe the rebuilt root rather than a cached miss.
      await mkdir(lateRoot, { recursive: true });
      await writeFile(join(lateRoot, "index.html"), INDEX_HTML);

      const served = await fetch(`${base(handle.port)}/`);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toContain("text/html");
      expect(await served.text()).toBe(INDEX_HTML);
    } finally {
      await handle.close();
      await rm(parent, { recursive: true, force: true });
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

  it("opens the fixed settings file through the guarded empty-body route", async () => {
    const { handle, state } = await start();
    try {
      const opened = await post(handle.port, "/api/v1/settings/open", {});
      expect(opened.status).toBe(200);
      expect(await opened.json()).toEqual({ opened: true });
      expect(state.openCalls).toBe(1);

      const wrongMethod = await get(handle.port, "/api/v1/settings/open");
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("POST");
      expect(errorOf(wrongMethod.body).code).toBe("method-not-allowed");

      const wrongType = await fetch(`${base(handle.port)}/api/v1/settings/open`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      expect(wrongType.status).toBe(415);
      expect(errorOf(await wrongType.json()).code).toBe("unsupported-media-type");

      const wrongOrigin = await fetch(`${base(handle.port)}/api/v1/settings/open`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://evil.example",
        },
        body: "{}",
      });
      expect(wrongOrigin.status).toBe(403);
      expect(errorOf(await wrongOrigin.json()).code).toBe("bad-origin");

      const crossSite = await fetch(`${base(handle.port)}/api/v1/settings/open`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: "{}",
      });
      expect(crossSite.status).toBe(403);
      expect(errorOf(await crossSite.json()).code).toBe("bad-origin");

      const malformed = await fetch(`${base(handle.port)}/api/v1/settings/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(malformed.status).toBe(400);
      expect(errorOf(await malformed.json()).code).toBe("bad-request");

      const nonEmpty = await post(handle.port, "/api/v1/settings/open", { path: "C:/secret" });
      expect(nonEmpty.status).toBe(400);
      expect(errorOf(await nonEmpty.json()).code).toBe("bad-request");

      const nonObject = await fetch(`${base(handle.port)}/api/v1/settings/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[]",
      });
      expect(nonObject.status).toBe(400);
      expect(errorOf(await nonObject.json()).code).toBe("bad-request");

      expect(state.openCalls).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("reports a controlled error when the settings store cannot open files", async () => {
    const { source, store } = buildFixtures();
    const { settings, saveSettings, saveVisibility, importPreview, importApply } = store;
    const withoutOpen: GuiSettingsStore = {
      settings,
      saveSettings,
      saveVisibility,
      importPreview,
      importApply,
    };
    const handle = await createDashboardServer({
      port: 0,
      source,
      settings: withoutOpen,
      assetRoot,
      logger: createGuiLogger({ sink: () => {} }),
    });
    try {
      const response = await post(handle.port, "/api/v1/settings/open", {});
      expect(response.status).toBe(409);
      const error = errorOf(await response.json());
      expect(error.code).toBe("config-target-error");
      expect(error.message).toBe("The dashboard config path is not writable");
      expect(error.message).not.toContain(assetRoot);
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

  it("accepts the explicit view-scope signal and rejects malformed ones", async () => {
    const { handle } = await start();
    try {
      const quota = await put(handle.port, "/api/v1/view", { scope: "quota" });
      expect(quota.status).toBe(200);
      expect(await quota.json()).toEqual({ scope: "quota" });

      const analytics = await put(handle.port, "/api/v1/view", { scope: "analytics" });
      expect(analytics.status).toBe(200);
      expect(await analytics.json()).toEqual({ scope: "analytics" });

      const unknownScope = await put(handle.port, "/api/v1/view", { scope: "other" });
      expect(unknownScope.status).toBe(400);
      expect(errorOf(await unknownScope.json()).code).toBe("bad-request");

      const notScope = await put(handle.port, "/api/v1/view", { view: "quota" });
      expect(notScope.status).toBe(400);

      const extra = await put(handle.port, "/api/v1/view", { scope: "quota", extra: true });
      expect(extra.status).toBe(400);

      const notJson = await fetch(`${base(handle.port)}/api/v1/view`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(notJson.status).toBe(400);
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

      const postQuota = await post(handle.port, "/api/v1/quota", {});
      expect(postQuota.status).toBe(405);
      expect(postQuota.headers.get("allow") ?? "").toContain("GET");

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

      const deleteView = await fetch(`${base(handle.port)}/api/v1/view`, { method: "DELETE" });
      expect(deleteView.status).toBe(405);
      expect(deleteView.headers.get("allow") ?? "").toContain("PUT");

      const unknown = await get(handle.port, "/api/v1/nope");
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown.body).code).toBe("not-found");
    } finally {
      await handle.close();
    }
  });
});
