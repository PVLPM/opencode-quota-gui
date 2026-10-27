import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeAnalyticsEntityToken } from "../src/contracts/analytics-entity.js";

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

interface GroupTokens extends TokenTotals {
  unpricedTokens: number;
  unknownTokens: number;
}

type GroupIdentity = { kind: "known"; id: string } | { kind: "unknown" };

interface GroupRowPayload {
  identity: GroupIdentity;
  tokens: GroupTokens;
  sessionCount: number;
  stepCount: number;
  children: GroupRowPayload[];
}

interface GroupSeriesPayload {
  kind: "entity" | "other";
  identity?: GroupIdentity;
  tokens: GroupTokens;
}

interface GroupSnapshotPayload {
  dimension: "model" | "provider";
  range: string;
  filter?: { dimension: "model" | "provider"; identity: GroupIdentity };
  rows: GroupRowPayload[];
  series: GroupSeriesPayload[];
  totals: GroupTokens;
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

function groupRowId(row: GroupRowPayload): string {
  return row.identity.kind === "unknown" ? "unknown" : row.identity.id;
}

function groupRow(snapshot: GroupSnapshotPayload, id: string): GroupRowPayload {
  const row = snapshot.rows.find((entry) => groupRowId(entry) === id);
  if (row === undefined) throw new Error(`synthetic fixture row ${id} is missing`);
  return row;
}

function seriesName(series: GroupSeriesPayload): string {
  if (series.kind === "other") return "other";
  if (series.identity === undefined) throw new Error("an entity series has no identity");
  return series.identity.kind === "unknown" ? "unknown" : series.identity.id;
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
    expect(health.body).toEqual({
      app: "opencode-quota-gui",
      contractVersion: 2,
      version: expect.any(String),
      build: expect.any(String),
    });
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
    expect(stepCounts).toEqual([13, 15, 18, 19]);
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
    expect(home.body.usage.totals.total).toBe(8865);

    // Raw account source ids never reach the browser payload.
    const serializedCards = JSON.stringify(cards);
    expect(serializedCards).not.toContain("acct_synthetic_one");
    expect(serializedCards).not.toContain("acct_synthetic_two");
  });

  it("serves model analytics with one shared raw model across three providers and Other", async () => {
    const response = await requestJson<GroupSnapshotPayload>(apiUrl("/models?range=7d"));
    expect(response.status).toBe(200);
    expect(response.body.dimension).toBe("model");
    expect(response.body.range).toBe("7d");

    expect(response.body.rows.map(groupRowId)).toEqual([
      "gpt-5",
      "synthetic-unpriced-model",
      "gpt-5-mini",
      "kimi-k2.5",
      "grok-4",
      "gemini-2.5-flash",
      "claude-3-5-haiku-latest",
    ]);

    // One raw model id recorded through three provider gateways (the pre-existing
    // openai rows use the same gpt-5 id). The provider children are the exact raw
    // provider ids, ranked by selected-range tokens.
    const shared = groupRow(response.body, "gpt-5");
    expect(shared.tokens.total).toBe(2545);
    expect(shared.children.map(groupRowId)).toEqual(["openai", "google", "anthropic"]);
    expect(shared.children.map((child) => child.tokens.total)).toEqual([1475, 545, 525]);

    // >5 models means the chart carries five entities plus a merged Other.
    expect(response.body.series).toHaveLength(6);
    expect(response.body.series.map(seriesName)).toEqual([
      "gpt-5",
      "synthetic-unpriced-model",
      "gpt-5-mini",
      "kimi-k2.5",
      "grok-4",
      "other",
    ]);
    expect(response.body.series[5]?.tokens.total).toBe(1220);
  });

  it("serves provider analytics with >5 providers, multi-model providers and pricing gaps", async () => {
    const response = await requestJson<GroupSnapshotPayload>(apiUrl("/providers?range=7d"));
    expect(response.status).toBe(200);
    expect(response.body.dimension).toBe("provider");
    expect(response.body.range).toBe("7d");

    expect(response.body.rows.map(groupRowId)).toEqual([
      "openai",
      "anthropic",
      "google",
      "unknown",
      "acme-inference",
      "moonshotai",
      "xai",
    ]);

    // One provider using several raw models, including the unpriced one, so the
    // provider total is a numeric estimate with excluded tokens (Partial estimate).
    const anthropic = groupRow(response.body, "anthropic");
    expect(anthropic.tokens.total).toBe(1805);
    expect(anthropic.tokens.apiEquivalentCostUsd).not.toBeNull();
    expect(anthropic.tokens.unknownTokens).toBe(705);
    expect(anthropic.children.map(groupRowId)).toEqual([
      "synthetic-unpriced-model",
      "claude-3-5-haiku-latest",
      "gpt-5",
    ]);

    // A raw provider id the presentation catalog does not know keeps its raw
    // identity for the generic-label/logo fallback; all of its tokens are unpriced.
    const catalogFallback = groupRow(response.body, "acme-inference");
    expect(catalogFallback.tokens.total).toBe(755);
    expect(catalogFallback.tokens.apiEquivalentCostUsd).toBeNull();
    expect(catalogFallback.tokens.unknownTokens).toBe(755);

    // A missing provider id is the explicit unknown identity. Its model is still
    // uniquely priceable, so this is not fabricated as zero cost.
    const unknown = groupRow(response.body, "unknown");
    expect(unknown.tokens.total).toBe(765);
    expect(unknown.tokens.apiEquivalentCostUsd).toBeGreaterThan(0);

    expect(response.body.series).toHaveLength(6);
    expect(response.body.series.map(seriesName)).toEqual([
      "openai",
      "anthropic",
      "google",
      "unknown",
      "acme-inference",
      "other",
    ]);
    expect(response.body.series[5]?.tokens.total).toBe(1360);
  });

  it("serves exact model/provider detail routes for the QA fixture identities", async () => {
    const sharedToken = encodeAnalyticsEntityToken({ kind: "known", id: "gpt-5" });
    const shared = await requestJson<GroupSnapshotPayload>(
      apiUrl(`/models/${sharedToken}?range=7d`),
    );
    expect(shared.status).toBe(200);
    expect(shared.body.dimension).toBe("provider");
    expect(shared.body.filter).toEqual({
      dimension: "model",
      identity: { kind: "known", id: "gpt-5" },
    });
    expect(shared.body.rows.map(groupRowId)).toEqual(["openai", "google", "anthropic"]);
    expect(shared.body.totals.total).toBe(2545);

    const anthropicToken = encodeAnalyticsEntityToken({ kind: "known", id: "anthropic" });
    const anthropic = await requestJson<GroupSnapshotPayload>(
      apiUrl(`/providers/${anthropicToken}?range=7d`),
    );
    expect(anthropic.status).toBe(200);
    expect(anthropic.body.dimension).toBe("model");
    expect(anthropic.body.rows.map(groupRowId)).toEqual([
      "synthetic-unpriced-model",
      "claude-3-5-haiku-latest",
      "gpt-5",
    ]);
    expect(anthropic.body.totals.total).toBe(1805);
    expect(anthropic.body.totals.apiEquivalentCostUsd).not.toBeNull();
    expect(anthropic.body.totals.unknownTokens).toBe(705);

    const unknown = await requestJson<GroupSnapshotPayload>(apiUrl("/providers/u?range=7d"));
    expect(unknown.status).toBe(200);
    expect(unknown.body.filter).toEqual({
      dimension: "provider",
      identity: { kind: "unknown" },
    });
    expect(unknown.body.rows.map(groupRowId)).toEqual(["gpt-5-mini"]);
    expect(unknown.body.totals.total).toBe(765);
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
    expect(project.body.totals.total).toBe(8085);

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
    // Compaction ticks annotate the focus session only; a descendant's marker
    // never appears on the ancestor's chart.
    expect(session.body.compactionMarkers).toEqual([]);
    const child = await requestJson<SessionPayload>(apiUrl("/sessions/ses_alpha_child2"));
    expect(child.status).toBe(200);
    expect(child.body.compactionMarkers.map((marker) => marker.messageId)).toEqual([
      "msg_compaction_c2",
    ]);
    expect(session.body.ownSummary.stepCount).toBe(2);
    expect(session.body.ownSummary.total).toBe(280);
    expect(session.body.treeTotals.total).toBe(760);
  });

  it("writes settings and visibility to the canonical file and imports the legacy sidecar", async () => {
    // The smoke process owns this synthetic config root. Migration only accepts
    // eligible global legacy concepts, never hidden fields or project overrides.
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    if (!configDir) throw new Error("synthetic config directory is not set");
    const legacyPath = join(configDir, "opencode-quota", "quota-toast.jsonc");
    const projectPath = join(
      configDir,
      "..",
      "workspace",
      "alpha",
      "opencode-quota",
      "quota-toast.jsonc",
    );
    const canonicalPath = join(configDir, "opencode-quota-gui", "config.jsonc");
    const legacyBytes = '{ "waitForQuotaReset": true, "resetTimeDecimals": 1 }\n';
    await mkdir(join(configDir, "opencode-quota"), { recursive: true });
    await writeFile(legacyPath, legacyBytes);
    const projectBytes = await readFile(projectPath, "utf8");
    const initial = await requestJson<SettingsPayload>(apiUrl("/settings"));
    expect(initial.status).toBe(200);
    // Canonical runtime only: the project sidecar and global legacy sidecar are
    // import candidates, never live settings. resetTimeDecimals is not an
    // importable legacy key, so it stays at its default (null).
    expect(initial.body.values.resetTimeDecimals).toBeNull();
    expect(initial.body.sources.resetTimeDecimals).toBe("defaults");
    expect(initial.body.values.waitForQuotaReset).toBe(true);
    expect(initial.body.sources.waitForQuotaReset).toBe("defaults");

    const withoutPreview = await requestJson<ErrorPayload>(apiUrl("/settings/import"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: initial.body.revision }),
    });
    expect(withoutPreview.status).toBe(409);
    expect(withoutPreview.body.error.code).toBe("config-changed");

    const preview = await requestJson<ImportPreviewPayload>(apiUrl("/settings/import"));
    expect(preview.status).toBe(200);
    expect(preview.body.keys).toEqual([{ key: "waitForQuotaReset", value: true }]);
    expect(preview.body.keys.some(({ key }) => key === "resetTimeDecimals")).toBe(false);
    expect(preview.body.from).toBe("global opencode-quota/quota-toast.jsonc");
    expect(preview.body.expectedRevision).toBe(initial.body.revision);
    await expect(readFile(canonicalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const imported = await requestJson<WriteResultPayload>(apiUrl("/settings/import"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: preview.body.expectedRevision }),
    });
    expect(imported.status).toBe(200);
    expect(imported.body.applied).toEqual({ waitForQuotaReset: true });
    expect(imported.body.revision).not.toBe(initial.body.revision);
    expect(await readFile(canonicalPath, "utf8")).toMatch(/"waitForQuotaReset"\s*:\s*true/);

    const afterImport = await requestJson<SettingsPayload>(apiUrl("/settings"));
    expect(afterImport.body.values.waitForQuotaReset).toBe(true);
    expect(afterImport.body.sources.waitForQuotaReset).toBe("opencode-quota-gui/config.jsonc");
    // The project sidecar and non-importable legacy keys still never become live.
    expect(afterImport.body.values.resetTimeDecimals).toBeNull();
    expect(afterImport.body.sources.resetTimeDecimals).toBe("defaults");

    const saved = await putJson<WriteResultPayload>(apiUrl("/settings"), {
      patch: { resetTimeDecimals: 1 },
      expectedRevision: afterImport.body.revision,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.applied.resetTimeDecimals).toBe(1);

    const afterSave = await requestJson<SettingsPayload>(apiUrl("/settings"));
    expect(afterSave.body.values.resetTimeDecimals).toBe(1);
    expect(afterSave.body.sources.resetTimeDecimals).toBe("opencode-quota-gui/config.jsonc");
    expect(afterSave.body.values.waitForQuotaReset).toBe(true);
    expect(afterSave.body.sources.waitForQuotaReset).toBe("opencode-quota-gui/config.jsonc");

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
    // The saved canonical value stays effective; the project sidecar never wins.
    expect(afterVisibility.body.values.resetTimeDecimals).toBe(1);
    expect(afterVisibility.body.sources.resetTimeDecimals).toBe("opencode-quota-gui/config.jsonc");
    expect(afterVisibility.body.visibility).toEqual({
      hiddenCards: ["synthetic-card"],
      hiddenRows: [],
    });
    expect(afterVisibility.body.values.waitForQuotaReset).toBe(true);
    expect(await readFile(legacyPath, "utf8")).toBe(legacyBytes);
    expect(await readFile(projectPath, "utf8")).toBe(projectBytes);
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
