import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer, request as httpRequest } from "node:http";
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
import { createGuiLogger } from "../src/gui/log.js";
import {
  createDashboardServer,
  DashboardBindError,
  type DashboardServerHandle,
} from "../src/gui/server.js";
import type { SnapshotSource } from "../src/gui/snapshot-service.js";

const NOW = Date.parse("2026-10-18T10:30:00.000Z");
const INDEX_HTML = "<!doctype html><html><body>shell</body></html>";
const OUTSIDE_SECRET = "OUTSIDE-SECRET-DO-NOT-SERVE";

const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

interface Fixtures {
  source: SnapshotSource;
  store: GuiSettingsStore;
}

function buildFixtures(): Fixtures {
  const source: SnapshotSource = {
    home: async ({ range }) => homeSnapshot(range),
    project: async ({ projectId, range }) => projectSnapshot(projectId, range),
    session: async ({ sessionId }) => sessionSnapshot(sessionId),
  };
  const settingsPayload: SettingsSnapshot = {
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
  const store: GuiSettingsStore = {
    settings: async () => settingsPayload,
    saveSettings: async (input): Promise<SettingsWriteResult> => ({
      revision: "rev-2",
      applied: input.patch,
      warnings: [],
    }),
    saveVisibility: async (input): Promise<SettingsWriteResult> => ({
      revision: "rev-2",
      applied: {
        "dashboard.hiddenCards": input.hiddenCards,
        "dashboard.hiddenRows": input.hiddenRows,
      },
      warnings: [],
    }),
    importPreview: async (): Promise<ImportPreview> => ({
      from: "",
      keys: [],
      issues: [],
      expectedRevision: "rev-1",
    }),
    importApply: async (): Promise<SettingsWriteResult> => ({
      revision: "rev-2",
      applied: {},
      warnings: [],
    }),
  };
  return { source, store };
}

let baseDir = "";
let assetRoot = "";
let secretPath = "";

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "gui-p4-security-"));
  assetRoot = join(baseDir, "root");
  secretPath = join(baseDir, "outside.txt");
  await mkdir(join(assetRoot, "assets"), { recursive: true });
  await mkdir(join(assetRoot, "assets", "providers"), { recursive: true });
  await writeFile(join(assetRoot, "index.html"), INDEX_HTML);
  await writeFile(join(assetRoot, "assets", "app.js"), "console.log('app');");
  await writeFile(
    join(assetRoot, "assets", "providers", "openai.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
  );
  await writeFile(secretPath, OUTSIDE_SECRET);
});

afterAll(async () => {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

async function start(): Promise<DashboardServerHandle> {
  const { source, store } = buildFixtures();
  return createDashboardServer({
    port: 0,
    source,
    settings: store,
    assetRoot,
    logger: createGuiLogger({ sink: () => {} }),
  });
}

function base(port: number): string {
  return `http://127.0.0.1:${port}`;
}

interface RawResult {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

function raw(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: options.path, method: options.method ?? "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (options.headers) {
      for (const [name, value] of Object.entries(options.headers)) req.setHeader(name, value);
    }
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function put(port: number, path: string, payload: JsonValue, headers: Record<string, string> = {}) {
  return fetch(`${base(port)}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

describe("GUI server security", () => {
  it("binds loopback only and rejects foreign Host authorities", async () => {
    const handle = await start();
    try {
      expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);

      const foreignHost = await raw(handle.port, {
        path: "/api/v1/health",
        headers: { host: "evil.example" },
      });
      expect(foreignHost.status).toBe(403);
      expect(JSON.parse(foreignHost.body).error.code).toBe("bad-host");

      const foreignPort = await raw(handle.port, {
        path: "/api/v1/health",
        headers: { host: `evil.example:${handle.port}` },
      });
      expect(foreignPort.status).toBe(403);

      const localhost = await raw(handle.port, {
        path: "/api/v1/health",
        headers: { host: `localhost:${handle.port}` },
      });
      expect(localhost.status).toBe(200);
      expect(JSON.parse(localhost.body)).toEqual({
        app: "opencode-quota-gui",
        contractVersion: 2,
        version: expect.any(String),
        build: expect.any(String),
      });
    } finally {
      await handle.close();
    }
  });

  it("guards writes by Origin and Sec-Fetch-Site with no CORS headers", async () => {
    const handle = await start();
    const body = { patch: { minIntervalMs: 60000 }, expectedRevision: "rev-1" };
    try {
      const absent = await put(handle.port, "/api/v1/settings", body);
      expect(absent.status).toBe(200);

      const exact = await put(handle.port, "/api/v1/settings", body, {
        origin: `http://127.0.0.1:${handle.port}`,
      });
      expect(exact.status).toBe(200);

      const localhostOrigin = await put(handle.port, "/api/v1/settings", body, {
        origin: `http://localhost:${handle.port}`,
      });
      expect(localhostOrigin.status).toBe(200);

      const foreign = await put(handle.port, "/api/v1/settings", body, {
        origin: "http://evil.example",
      });
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({ error: { code: "bad-origin" } });

      const crossSite = await put(handle.port, "/api/v1/settings", body, {
        "sec-fetch-site": "cross-site",
      });
      expect(crossSite.status).toBe(403);

      const sameOrigin = await put(handle.port, "/api/v1/settings", body, {
        "sec-fetch-site": "same-origin",
      });
      expect(sameOrigin.status).toBe(200);

      const none = await put(handle.port, "/api/v1/settings", body, {
        "sec-fetch-site": "none",
      });
      expect(none.status).toBe(200);

      const importWrite = await fetch(`${base(handle.port)}/api/v1/settings/import`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ expectedRevision: "rev-1" }),
      });
      expect(importWrite.status).toBe(403);

      const corsProbe = await raw(handle.port, {
        path: "/api/v1/health",
        headers: { origin: "http://evil.example" },
      });
      expect(corsProbe.status).toBe(200);
      expect(corsProbe.headers["access-control-allow-origin"]).toBeUndefined();
      expect(corsProbe.headers["access-control-allow-credentials"]).toBeUndefined();

      const writeCors = await put(handle.port, "/api/v1/settings", body, {
        origin: `http://127.0.0.1:${handle.port}`,
      });
      expect(writeCors.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it("sets the security headers and CSP on every response", async () => {
    const handle = await start();
    try {
      const health = await raw(handle.port, { path: "/api/v1/health" });
      expect(health.headers["content-security-policy"]).toBe(EXPECTED_CSP);
      expect(health.headers["x-content-type-options"]).toBe("nosniff");
      expect(health.headers["referrer-policy"]).toBe("no-referrer");
      expect(health.headers["cache-control"]).toBe("no-store");

      const asset = await raw(handle.port, { path: "/assets/app.js" });
      expect(asset.status).toBe(200);
      expect(asset.headers["content-security-policy"]).toBe(EXPECTED_CSP);
      expect(asset.headers["cache-control"]).toBe("no-store");

      const providerLogo = await raw(handle.port, { path: "/assets/providers/openai.svg" });
      expect(providerLogo.status).toBe(200);
      expect(providerLogo.headers["content-type"]).toBe("image/svg+xml");
      expect(providerLogo.body).toContain("<svg");
      expect(providerLogo.headers["content-security-policy"]).toBe(EXPECTED_CSP);
    } finally {
      await handle.close();
    }
  });

  it("rejects traversal and encoded path escapes without serving outside files", async () => {
    const handle = await start();
    try {
      const vectors = [
        "/assets/%2e%2e/outside.txt",
        "/assets/%2e%2e%2foutside.txt",
        "/assets/%5c..%5coutside.txt",
        "/assets/index.html%00.txt",
        "/assets/C:%5coutside.txt",
        "/assets/%2fetc%2fpasswd",
        "/assets/%252e%252e%252foutside.txt",
      ];
      for (const path of vectors) {
        const response = await fetch(`${base(handle.port)}${path}`);
        expect([400, 404]).toContain(response.status);
        const text = await response.text();
        expect(text).not.toContain(OUTSIDE_SECRET);
      }

      const rawPath = await raw(handle.port, { path: "/assets/../outside.txt" });
      expect([400, 404]).toContain(rawPath.status);
      expect(rawPath.body).not.toContain(OUTSIDE_SECRET);

      const dotSegment = await raw(handle.port, { path: "/assets/..%2foutside.txt" });
      expect([400, 404]).toContain(dotSegment.status);
      expect(dotSegment.body).not.toContain(OUTSIDE_SECRET);

      const stillServed = await fetch(`${base(handle.port)}/assets/app.js`);
      expect(stillServed.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("rejects a symlink escape from the asset root", async (context) => {
    // File symlinks need privileges on Windows; a directory junction is the
    // unprivileged equivalent and exercises the same realpath containment.
    let escapePath = "/assets/escape.js";
    let linkPath = join(assetRoot, "assets", "escape.js");
    try {
      await symlink(secretPath, linkPath, "file");
    } catch {
      const outsideDir = join(baseDir, "outside-dir");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, "leak.js"), OUTSIDE_SECRET);
      escapePath = "/assets/escape-dir/leak.js";
      linkPath = join(assetRoot, "assets", "escape-dir");
      try {
        await symlink(outsideDir, linkPath, "junction");
      } catch {
        context.skip();
        return;
      }
    }

    const handle = await start();
    try {
      const response = await fetch(`${base(handle.port)}${escapePath}`);
      expect([400, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(OUTSIDE_SECRET);
    } finally {
      await handle.close();
      await rm(linkPath, { force: true, recursive: true });
    }
  });

  it("requires application/json on writes and refuses other media types", async () => {
    const handle = await start();
    try {
      const wrongType = await fetch(`${base(handle.port)}/api/v1/settings`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ patch: {}, expectedRevision: "rev-1" }),
      });
      expect(wrongType.status).toBe(415);
      expect(await wrongType.json()).toMatchObject({ error: { code: "unsupported-media-type" } });

      const charsetAccepted = await fetch(`${base(handle.port)}/api/v1/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ patch: {}, expectedRevision: "rev-1" }),
      });
      expect(charsetAccepted.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("rejects an occupied port with a structured unavailable error and one log line", async () => {
    const blocker = createNetServer((socket) => socket.end());
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        const address = blocker.address();
        if (address === null || typeof address === "string") throw new Error("no port");
        resolve(address.port);
      });
    });

    const logs: string[] = [];
    const { source, store } = buildFixtures();
    try {
      let error: unknown;
      try {
        await createDashboardServer({
          port,
          source,
          settings: store,
          assetRoot,
          logger: createGuiLogger({ sink: (line) => logs.push(line) }),
        });
        error = undefined;
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(DashboardBindError);
      if (!(error instanceof DashboardBindError)) {
        throw new Error("expected DashboardBindError");
      }
      expect(error.code).toBe("unavailable");
      expect(error.port).toBe(port);
      expect(error.reason).toBe("EADDRINUSE");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("unavailable");
      expect(logs[0]).toContain("EADDRINUSE");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
