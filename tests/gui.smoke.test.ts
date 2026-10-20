import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * P7 synthetic smoke over the built artifacts (plan P7 step 2; spec §12
 * R43/R49/R51).
 *
 * Everything here is synthetic: `scripts/smoke-gui.mjs` seeds an invented
 * SQLite database, an invented workspace, and invented provider DTOs in its own
 * temp root, points `OPENCODE_DB`/`OPENCODE_CONFIG_DIR`/XDG dirs at that root,
 * and starts the real `dist/gui` server, read source, and settings store. No
 * real config, database, credential, or provider API is read. Assertions cover
 * the real HTTP contract: health, home per range (every metric changes), project
 * rows, the recursive session tree, settings/visibility writes, import, and the
 * occupied-port failure; the CLI contract is checked on a spawned child process.
 */

const FIXED_NOW_MS = Date.UTC(2026, 0, 5, 12, 0, 0);
const SMOKE_SCRIPT = fileURLToPath(new URL("../scripts/smoke-gui.mjs", import.meta.url));
const SMOKE_SCRIPT_URL = pathToFileURL(SMOKE_SCRIPT).href;
const SYNTHETIC_NOTICE =
  "synthetic fixture data only; no real OpenCode config, database, or provider API is read";

interface TokenTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  apiEquivalentCostUsd: number | null;
}

interface CardRow {
  rowId: string;
  kind: string;
  percentRemaining?: number;
  quantity?: { decimal: string; unit: { kind: string; code?: string } };
}

interface ProviderCardPayload {
  cardId: string;
  providerId: string;
  accountLabel?: string;
  labelSource: string;
  rows: CardRow[];
}

interface HomePayload {
  usage: { totals: TokenTotals; stepCount: number };
  projects: { projectId: string; name: string; latestActivityAtMs: number }[];
  providers: { cards: ProviderCardPayload[] };
}

interface QuotaPayload {
  generatedAtMs: number;
  stale: boolean;
  providers: {
    cards: ProviderCardPayload[];
    enabledProviders: string[] | "auto";
    polledAtMs: number;
  };
}

interface ProjectPayload {
  name: string;
  roots: { sessionId: string; worktreeLabel?: string; tokens: TokenTotals }[];
  totals: TokenTotals & { sessionCount: number };
}

interface SessionPayload {
  focusSessionId: string;
  breadcrumbs: { sessionId: string; isFocus: boolean }[];
  nodes: { sessionId: string; depth: number; childIds: string[]; subtreeTokens: TokenTotals }[];
  steps: { sessionId: string; messageId: string }[];
  compactionMarkers: { sessionId: string; messageId: string }[];
  ownSummary: TokenTotals & { stepCount: number };
  treeTotals: TokenTotals;
}

type SettingValue = string | number | boolean | null | string[];

interface SettingsPayload {
  revision: string;
  values: { [key: string]: SettingValue };
  sources: { [key: string]: string };
  visibility: { hiddenCards: string[]; hiddenRows: string[] };
}

interface WriteResultPayload {
  revision: string;
  applied: { [key: string]: SettingValue };
}

interface ImportPreviewPayload {
  from: string;
  keys: { key: string; value: SettingValue }[];
  expectedRevision: string;
}

interface ErrorPayload {
  error: { code: string; message: string };
}

interface SmokeHandle {
  url: string;
  close(): Promise<void>;
}

interface SmokeModule {
  startSyntheticDashboard(options?: { port?: number; nowMs?: number }): Promise<SmokeHandle>;
}

let dashboard: SmokeHandle | undefined;

beforeAll(async () => {
  // SAFETY: scripts/smoke-gui.mjs is the executor-owned smoke module; its one
  // export starts the built dashboard over the synthetic fixture and resolves
  // to the handle with the URL asserted below.
  const smoke = (await import(SMOKE_SCRIPT_URL)) as SmokeModule;
  dashboard = await smoke.startSyntheticDashboard({ port: 0, nowMs: FIXED_NOW_MS });
}, 30_000);

afterAll(async () => {
  await dashboard?.close();
}, 30_000);

function apiUrl(path: string): string {
  if (dashboard === undefined) throw new Error("smoke dashboard is not running");
  return `${dashboard.url}/api/v1${path}`;
}

async function requestJson<Payload>(
  url: string,
  init?: { method: string; headers: { [name: string]: string }; body: string },
): Promise<{ status: number; body: Payload }> {
  const response = await fetch(url, init);
  // SAFETY: every dashboard route used here answers with the frozen contract
  // JSON; the field-level expectations below are exactly what verifies it.
  const body = (await response.json()) as Payload;
  return { status: response.status, body };
}

function putJson<Payload>(
  url: string,
  payload: { [key: string]: SettingValue },
): Promise<{ status: number; body: Payload }> {
  return requestJson<Payload>(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function readCliStdout(child: ChildProcessWithoutNullStreams): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error("the CLI did not print its ready lines in time"));
    }, 20_000);
    const settle = (lines: string[] | undefined, error?: Error) => {
      clearTimeout(timer);
      if (lines !== undefined) resolve(lines);
      else if (error !== undefined) reject(error);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n").filter((line) => line !== "");
      if (lines.length >= 2) settle(lines);
    });
    child.once("error", (error) => settle(undefined, error));
    child.once("exit", () => settle(undefined, new Error("the CLI exited before it was ready")));
  });
}

async function waitForCliExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

describe("synthetic GUI smoke", () => {
  it("starts on loopback and serves health without any real data", async () => {
    expect(dashboard?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await requestJson<{ app: string; contractVersion: number }>(apiUrl("/health"));
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ app: "opencode-quota-gui", contractVersion: 1 });
  });

  it("changes every token metric across ranges and keeps project rows latest-first", async () => {
    const ranges = ["24h", "7d", "30d", "lifetime"] as const;
    const totals: TokenTotals[] = [];
    const stepCounts: number[] = [];
    const projectOrders: string[][] = [];

    for (const range of ranges) {
      const home = await requestJson<HomePayload>(apiUrl(`/home?range=${range}`));
      expect(home.status).toBe(200);
      totals.push(home.body.usage.totals);
      stepCounts.push(home.body.usage.stepCount);
      projectOrders.push(home.body.projects.map((project) => project.projectId));

      const activity = home.body.projects.map((project) => project.latestActivityAtMs);
      expect(activity).toEqual([...activity].sort((left, right) => right - left));
    }

    const metrics = ["input", "cacheRead", "cacheWrite", "output", "reasoning", "total"] as const;
    for (let index = 1; index < totals.length; index += 1) {
      for (const metric of metrics) {
        expect(totals[index][metric]).toBeGreaterThan(totals[index - 1][metric]);
      }
    }
    expect(stepCounts).toEqual([2, 4, 7, 8]);
    expect(projectOrders[0]).toEqual(["proj_alpha", "proj_beta"]);
    expect(projectOrders[3]).toEqual(["proj_alpha", "proj_beta", "proj_empty"]);
  });

  it("maps two synthetic accounts and a provider amount that is not the API-equivalent cost", async () => {
    // The quota surface is independent; home analytics must not wait on or
    // carry provider cards.
    const home = await requestJson<HomePayload>(apiUrl("/home?range=lifetime"));
    expect(home.status).toBe(200);
    expect(home.body.providers.cards).toEqual([]);

    const quota = await requestJson<QuotaPayload>(apiUrl("/quota"));
    expect(quota.status).toBe(200);
    expect(quota.body.stale).toBe(false);
    expect(quota.body.providers.polledAtMs).toBe(FIXED_NOW_MS);
    const cards = quota.body.providers.cards;

    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((card) => card.cardId)).size).toBe(3);
    expect(cards.filter((card) => card.accountLabel !== undefined)).toHaveLength(2);
    expect(cards.filter((card) => card.labelSource === "provider")).toHaveLength(1);

    const quantityRows = cards
      .flatMap((card) => card.rows)
      .filter((row) => row.kind === "quantity");
    expect(quantityRows).toHaveLength(1);
    expect(quantityRows[0].quantity).toEqual({
      decimal: "42.50",
      unit: { kind: "currency", code: "USD" },
    });

    // The provider-reported amount is real content, not the dashboard's cost:
    // the API-equivalent cost is computed from the synthetic token rows instead.
    const apiEquivalentCostUsd = home.body.usage.totals.apiEquivalentCostUsd ?? -1;
    expect(apiEquivalentCostUsd).toBeGreaterThan(0);
    expect(apiEquivalentCostUsd).toBeLessThan(42.5);
    expect(home.body.usage.totals.total).toBe(1920);

    // Raw account source ids never reach the browser payload.
    const serializedCards = JSON.stringify(cards);
    expect(serializedCards).not.toContain("acct_synthetic_one");
    expect(serializedCards).not.toContain("acct_synthetic_two");
  });

  it("serves the project page with worktree labels and the recursive session tree", async () => {
    const project = await requestJson<ProjectPayload>(
      apiUrl("/projects/proj_alpha?range=lifetime"),
    );
    expect(project.status).toBe(200);
    expect(project.body.name).toBe("Synthetic Alpha");
    expect(project.body.roots.map((root) => root.sessionId)).toEqual([
      "ses_alpha_root",
      "ses_alpha_wt",
    ]);
    expect(project.body.roots.map((root) => root.worktreeLabel)).toEqual(["alpha", "alpha-wt2"]);
    expect(project.body.totals.sessionCount).toBe(5);
    expect(project.body.totals.total).toBe(1140);

    const session = await requestJson<SessionPayload>(apiUrl("/sessions/ses_alpha_child1"));
    expect(session.status).toBe(200);
    expect(session.body.focusSessionId).toBe("ses_alpha_child1");
    expect(session.body.breadcrumbs.map((crumb) => crumb.sessionId)).toEqual([
      "ses_alpha_root",
      "ses_alpha_child1",
    ]);
    expect(session.body.nodes.map((node) => node.sessionId)).toEqual([
      "ses_alpha_child1",
      "ses_alpha_child2",
      "ses_alpha_child3",
    ]);
    expect(session.body.nodes.map((node) => node.depth)).toEqual([0, 1, 2]);
    expect(session.body.nodes[0].childIds).toEqual(["ses_alpha_child2"]);
    expect(session.body.nodes[0].subtreeTokens.total).toBe(760);
    expect(session.body.steps.map((step) => step.messageId)).toEqual([
      "msg_a_c3_lifetime",
      "msg_a_c2_month",
      "msg_a_c1_week",
      "msg_a_c1_recent",
    ]);
    expect(session.body.compactionMarkers.map((marker) => marker.messageId)).toEqual([
      "msg_compaction_c2",
    ]);
    expect(session.body.ownSummary.stepCount).toBe(2);
    expect(session.body.ownSummary.total).toBe(280);
    expect(session.body.treeTotals.total).toBe(760);
  });

  it("writes settings and visibility to the canonical file and imports the legacy sidecar", async () => {
    const initial = await requestJson<SettingsPayload>(apiUrl("/settings"));
    expect(initial.status).toBe(200);
    expect(initial.body.values.resetTimeDecimals).toBe(2);
    expect(initial.body.sources.resetTimeDecimals).toBe("project opencode-quota/quota-toast.jsonc");

    const preview = await requestJson<ImportPreviewPayload>(apiUrl("/settings/import"));
    expect(preview.status).toBe(200);
    expect(preview.body.keys).toEqual([{ key: "resetTimeDecimals", value: 2 }]);
    expect(preview.body.expectedRevision).toBe(initial.body.revision);

    const imported = await requestJson<WriteResultPayload>(apiUrl("/settings/import"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: preview.body.expectedRevision }),
    });
    expect(imported.status).toBe(200);
    expect(imported.body.applied.resetTimeDecimals).toBe(2);

    const afterImport = await requestJson<SettingsPayload>(apiUrl("/settings"));
    // The project sidecar still overrides the canonical file for this key.
    expect(afterImport.body.sources.resetTimeDecimals).toBe(
      "project opencode-quota/quota-toast.jsonc",
    );

    const saved = await putJson<WriteResultPayload>(apiUrl("/settings"), {
      patch: { resetTimeDecimals: 1 },
      expectedRevision: afterImport.body.revision,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.applied.resetTimeDecimals).toBe(1);

    const stale = await putJson<ErrorPayload>(apiUrl("/settings"), {
      patch: { resetTimeDecimals: 3 },
      expectedRevision: afterImport.body.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("config-changed");

    const visibility = await putJson<WriteResultPayload>(apiUrl("/visibility"), {
      hiddenCards: ["synthetic-card"],
      hiddenRows: [],
      expectedRevision: saved.body.revision,
    });
    expect(visibility.status).toBe(200);

    const afterVisibility = await requestJson<SettingsPayload>(apiUrl("/settings"));
    // The canonical write is stored but the project sidecar still wins.
    expect(afterVisibility.body.values.resetTimeDecimals).toBe(2);
    expect(afterVisibility.body.sources.resetTimeDecimals).toBe(
      "project opencode-quota/quota-toast.jsonc",
    );
    expect(afterVisibility.body.visibility).toEqual({
      hiddenCards: ["synthetic-card"],
      hiddenRows: [],
    });
  });

  it("fails cleanly on an occupied port with no fallback and restores the environment", async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (address === null) throw new Error("the port blocker has no address");
    const occupiedPort = address.port;
    const before = process.env.OPENCODE_DB;

    try {
      // SAFETY: scripts/smoke-gui.mjs rejects with the structured bind error
      // (`code: "unavailable"`, the requested port); fields are asserted here.
      const smoke = (await import(SMOKE_SCRIPT_URL)) as SmokeModule;
      const failure = await smoke
        .startSyntheticDashboard({ port: occupiedPort })
        .then(() => undefined)
        .catch((reason: { code?: string; port?: number }) => reason);
      expect(failure?.code).toBe("unavailable");
      expect(failure?.port).toBe(occupiedPort);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(process.env.OPENCODE_DB).toBe(before);
  });

  it("prints only the ready URL and the synthetic notice from the CLI", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "opencode-quota-gui-smoke-cli-"));
    try {
      // The child's own temp dirs stay inside the sandbox, so an abrupt kill on
      // a platform without POSIX signal delivery still leaves nothing behind.
      const child = spawn(process.execPath, [SMOKE_SCRIPT, "--port", "0"], {
        env: { ...process.env, TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox },
      });
      try {
        const lines = await readCliStdout(child);
        expect(lines).toHaveLength(2);
        const ready = /^synthetic dashboard ready at (http:\/\/127\.0\.0\.1:\d+)$/.exec(lines[0]);
        expect(ready).not.toBeNull();
        expect(lines[1]).toBe(SYNTHETIC_NOTICE);

        const readyUrl = ready?.[1];
        if (readyUrl === undefined) throw new Error("the CLI did not print a ready URL");
        const health = await requestJson<{ app: string }>(`${readyUrl}/api/v1/health`);
        expect(health.status).toBe(200);
        expect(health.body.app).toBe("opencode-quota-gui");
      } finally {
        child.kill();
        await waitForCliExit(child);
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
