/**
 * Synthetic GUI smoke fixture (P7; spec §12 R51).
 *
 * Every project, session, message, account, and label here is invented in this
 * file. The SQLite schema mirrors the one `tests/helpers/gui-database.ts` seeds
 * (the columns the real read-only readers feature-detect), and every timestamp
 * is relative to the injected `nowMs` so the same fixture covers the 24h / 7d /
 * 30d / lifetime ranges, a compaction marker, and an empty project. The same
 * rows also cover the model/provider analytics QA matrix: one raw model through
 * three providers, a multi-model provider, >5 models and >5 providers (Other),
 * a catalog-unknown provider fallback, and unpriced/partial pricing. Nothing in
 * this module reads OpenCode, the user profile, a provider, or the network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Fixed clock for the automated smoke test; the CLI uses the real clock. */
export const SYNTHETIC_NOW_MS = Date.UTC(2026, 0, 5, 12, 0, 0);

/** One synthetic provider with two accounts plus a provider-reported currency row. */
export const SYNTHETIC_PROVIDER_ID = "synthetic-labs";
export const SYNTHETIC_PROVIDER_LABEL = "Synthetic Labs";
/** Fake provider-reported amount; never the dashboard's API-equivalent cost. */
export const SYNTHETIC_PROVIDER_AMOUNT = "42.50";

/** Stable synthetic ids the smoke test asserts on. */
export const SYNTHETIC_IDS = {
  projects: { alpha: "proj_alpha", beta: "proj_beta", empty: "proj_empty" },
  sessions: {
    alphaRoot: "ses_alpha_root",
    alphaWorktree: "ses_alpha_wt",
    alphaChild1: "ses_alpha_child1",
    alphaChild2: "ses_alpha_child2",
    alphaChild3: "ses_alpha_child3",
    betaRoot: "ses_beta_root",
    emptyRoot: "ses_empty_root",
  },
  messages: {
    alphaChild1Recent: "msg_a_c1_recent",
    alphaChild1Week: "msg_a_c1_week",
    alphaChild2Month: "msg_a_c2_month",
    alphaRootMonth: "msg_a_root_month",
    alphaChild3Lifetime: "msg_a_c3_lifetime",
    alphaWorktreeWeek: "msg_a_wt_week",
    betaRecent: "msg_b_recent",
    betaMonth: "msg_b_month",
    sharedModelOpenai: "msg_models_shared_openai",
    sharedModelAnthropic: "msg_models_shared_anthropic",
    sharedModelGoogle: "msg_models_shared_google",
    openaiMini: "msg_models_openai_mini",
    anthropicClaude: "msg_models_anthropic_claude",
    googleGemini: "msg_models_google_gemini",
    xaiGrok: "msg_models_xai_grok",
    moonshotaiKimi: "msg_models_moonshotai_kimi",
    unpricedAnthropic: "msg_models_unpriced_anthropic",
    unpricedCatalogFallback: "msg_models_unpriced_catalog_fallback",
    unknownProvider: "msg_models_unknown_provider",
  },
  compaction: "msg_compaction_c2",
  accounts: { one: "acct_synthetic_one", two: "acct_synthetic_two" },
};

/**
 * Model/provider analytics QA identities (all recorded in `alphaRoot`).
 *
 * - `shared` is one raw model id used through three provider gateways, so its
 *   model detail lists exactly those three raw providers.
 * - `anthropic` carries several raw models, including the unpriced one, so its
 *   provider detail is a partial cost estimate rather than an all-or-nothing one.
 * - `catalogFallback` is absent from the bundled provider presentation catalog:
 *   the UI must fall back to the raw id and generic mark, while its tokens stay
 *   honestly unpriced (no invented cost).
 * - One row omits the provider id entirely, producing the explicit unknown
 *   provider identity and the "Unknown provider" label.
 *
 * All priced ids are real keys in the bundled models.dev snapshot, so costs are
 * deterministic and require no network or runtime pricing refresh.
 */
export const SYNTHETIC_ANALYTICS = {
  models: {
    shared: "gpt-5",
    openaiMini: "gpt-5-mini",
    anthropicClaude: "claude-3-5-haiku-latest",
    googleGemini: "gemini-2.5-flash",
    xaiGrok: "grok-4",
    moonshotaiKimi: "kimi-k2.5",
    unpriced: "synthetic-unpriced-model",
  },
  providers: {
    openai: "openai",
    anthropic: "anthropic",
    google: "google",
    xai: "xai",
    moonshotai: "moonshotai",
    catalogFallback: "acme-inference",
  },
};

/** The priced model the bundled models.dev snapshot knows; keeps cost derivable. */
const PRICED_MODEL = { providerID: "openai", id: "gpt-5" };

/** One message with all five token categories so every range changes every metric. */
function message(id, sessionID, completedMs, base, model = PRICED_MODEL) {
  return {
    id,
    sessionID,
    createdMs: completedMs - 2_000,
    completedMs,
    tokens: {
      input: base,
      cacheRead: base + 1,
      cacheWrite: base + 2,
      output: base + 3,
      reasoning: base + 4,
    },
    model,
  };
}

/**
 * Builds the synthetic rows for one `nowMs` and fixture workspace directory.
 * Timestamps on purpose beyond the 30d window exist only so `lifetime` differs.
 */
export function buildSyntheticRows(nowMs, workspaceDir) {
  const dir = (name) => join(workspaceDir, name);
  const projects = [
    { id: SYNTHETIC_IDS.projects.alpha, name: "Synthetic Alpha" },
    { id: SYNTHETIC_IDS.projects.beta, name: "Synthetic Beta" },
    { id: SYNTHETIC_IDS.projects.empty, name: "Synthetic Empty" },
  ];
  const projectDirectories = [
    { projectID: SYNTHETIC_IDS.projects.alpha, directory: dir("alpha") },
    { projectID: SYNTHETIC_IDS.projects.beta, directory: dir("beta") },
    { projectID: SYNTHETIC_IDS.projects.empty, directory: dir("empty") },
  ];
  // Two git worktrees on the same project (spec §6 project rows).
  const worktrees = [
    {
      projectID: SYNTHETIC_IDS.projects.alpha,
      directory: dir("alpha-wt"),
      strategy: "git_worktree",
    },
    {
      projectID: SYNTHETIC_IDS.projects.alpha,
      directory: dir("alpha-wt2"),
      strategy: "git_worktree",
    },
  ];
  // Root + a three-deep child chain, plus a second root living in a worktree.
  const sessions = [
    {
      id: SYNTHETIC_IDS.sessions.alphaRoot,
      title: "Synthetic Alpha root",
      projectID: SYNTHETIC_IDS.projects.alpha,
      directory: dir("alpha"),
      createdMs: nowMs - 260 * DAY_MS,
      updatedMs: nowMs - 15 * DAY_MS,
    },
    {
      id: SYNTHETIC_IDS.sessions.alphaWorktree,
      title: "Synthetic Alpha worktree",
      projectID: SYNTHETIC_IDS.projects.alpha,
      directory: dir("alpha-wt2"),
      createdMs: nowMs - 10 * DAY_MS,
      updatedMs: nowMs - 4 * DAY_MS,
    },
    {
      id: SYNTHETIC_IDS.sessions.alphaChild1,
      title: "Synthetic Alpha child one",
      parentID: SYNTHETIC_IDS.sessions.alphaRoot,
      projectID: SYNTHETIC_IDS.projects.alpha,
      directory: dir("alpha"),
      createdMs: nowMs - 240 * DAY_MS,
      updatedMs: nowMs - 2 * HOUR_MS,
    },
    {
      id: SYNTHETIC_IDS.sessions.alphaChild2,
      title: "Synthetic Alpha child two",
      parentID: SYNTHETIC_IDS.sessions.alphaChild1,
      projectID: SYNTHETIC_IDS.projects.alpha,
      directory: dir("alpha"),
      createdMs: nowMs - 230 * DAY_MS,
      updatedMs: nowMs - 9 * DAY_MS,
    },
    {
      id: SYNTHETIC_IDS.sessions.alphaChild3,
      title: "Synthetic Alpha child three",
      parentID: SYNTHETIC_IDS.sessions.alphaChild2,
      projectID: SYNTHETIC_IDS.projects.alpha,
      directory: dir("alpha-wt"),
      createdMs: nowMs - 220 * DAY_MS,
      updatedMs: nowMs - 200 * DAY_MS,
    },
    {
      id: SYNTHETIC_IDS.sessions.betaRoot,
      title: "Synthetic Beta root",
      projectID: SYNTHETIC_IDS.projects.beta,
      directory: dir("beta"),
      createdMs: nowMs - 30 * DAY_MS,
      updatedMs: nowMs - 6 * HOUR_MS,
    },
    // Empty project: a session with no completed assistant rows, older than 30d.
    {
      id: SYNTHETIC_IDS.sessions.emptyRoot,
      title: "Synthetic Empty root",
      projectID: SYNTHETIC_IDS.projects.empty,
      directory: dir("empty"),
      createdMs: nowMs - 60 * DAY_MS,
      updatedMs: nowMs - 60 * DAY_MS,
    },
  ];
  const messages = [
    message(
      SYNTHETIC_IDS.messages.alphaChild1Recent,
      SYNTHETIC_IDS.sessions.alphaChild1,
      nowMs - 2 * HOUR_MS,
      31,
    ),
    message(
      SYNTHETIC_IDS.messages.alphaChild1Week,
      SYNTHETIC_IDS.sessions.alphaChild1,
      nowMs - 3 * DAY_MS,
      21,
    ),
    message(
      SYNTHETIC_IDS.messages.alphaChild2Month,
      SYNTHETIC_IDS.sessions.alphaChild2,
      nowMs - 9 * DAY_MS,
      41,
    ),
    message(
      SYNTHETIC_IDS.messages.alphaRootMonth,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 15 * DAY_MS,
      11,
    ),
    message(
      SYNTHETIC_IDS.messages.alphaChild3Lifetime,
      SYNTHETIC_IDS.sessions.alphaChild3,
      nowMs - 200 * DAY_MS,
      51,
    ),
    message(
      SYNTHETIC_IDS.messages.alphaWorktreeWeek,
      SYNTHETIC_IDS.sessions.alphaWorktree,
      nowMs - 4 * DAY_MS,
      61,
    ),
    message(
      SYNTHETIC_IDS.messages.betaRecent,
      SYNTHETIC_IDS.sessions.betaRoot,
      nowMs - 6 * HOUR_MS,
      71,
    ),
    message(
      SYNTHETIC_IDS.messages.betaMonth,
      SYNTHETIC_IDS.sessions.betaRoot,
      nowMs - 20 * DAY_MS,
      81,
    ),
    // Analytics QA rows: one raw model through three providers, several models
    // for one provider, >5 models/providers (Other), an unpriced model, and an
    // omitted provider id. They live in `alphaRoot` so the existing
    // project/session/compaction hierarchy and quota probes stay unchanged.
    message(
      SYNTHETIC_IDS.messages.sharedModelOpenai,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 5 * HOUR_MS,
      101,
      { providerID: SYNTHETIC_ANALYTICS.providers.openai, id: SYNTHETIC_ANALYTICS.models.shared },
    ),
    message(
      SYNTHETIC_IDS.messages.sharedModelAnthropic,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 6 * HOUR_MS,
      103,
      {
        providerID: SYNTHETIC_ANALYTICS.providers.anthropic,
        id: SYNTHETIC_ANALYTICS.models.shared,
      },
    ),
    message(
      SYNTHETIC_IDS.messages.sharedModelGoogle,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 7 * HOUR_MS,
      107,
      { providerID: SYNTHETIC_ANALYTICS.providers.google, id: SYNTHETIC_ANALYTICS.models.shared },
    ),
    message(
      SYNTHETIC_IDS.messages.openaiMini,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 8 * HOUR_MS,
      109,
      {
        providerID: SYNTHETIC_ANALYTICS.providers.openai,
        id: SYNTHETIC_ANALYTICS.models.openaiMini,
      },
    ),
    message(
      SYNTHETIC_IDS.messages.anthropicClaude,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 9 * HOUR_MS,
      113,
      {
        providerID: SYNTHETIC_ANALYTICS.providers.anthropic,
        id: SYNTHETIC_ANALYTICS.models.anthropicClaude,
      },
    ),
    message(
      SYNTHETIC_IDS.messages.googleGemini,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 10 * HOUR_MS,
      127,
      {
        providerID: SYNTHETIC_ANALYTICS.providers.google,
        id: SYNTHETIC_ANALYTICS.models.googleGemini,
      },
    ),
    message(
      SYNTHETIC_IDS.messages.xaiGrok,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 4 * HOUR_MS,
      131,
      { providerID: SYNTHETIC_ANALYTICS.providers.xai, id: SYNTHETIC_ANALYTICS.models.xaiGrok },
    ),
    message(
      SYNTHETIC_IDS.messages.moonshotaiKimi,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 3 * HOUR_MS,
      137,
      {
        providerID: SYNTHETIC_ANALYTICS.providers.moonshotai,
        id: SYNTHETIC_ANALYTICS.models.moonshotaiKimi,
      },
    ),
    message(
      SYNTHETIC_IDS.messages.unpricedAnthropic,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 1 * HOUR_MS,
      139,
      {
        providerID: SYNTHETIC_ANALYTICS.providers.anthropic,
        id: SYNTHETIC_ANALYTICS.models.unpriced,
      },
    ),
    message(
      SYNTHETIC_IDS.messages.unpricedCatalogFallback,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 2 * HOUR_MS,
      149,
      {
        providerID: SYNTHETIC_ANALYTICS.providers.catalogFallback,
        id: SYNTHETIC_ANALYTICS.models.unpriced,
      },
    ),
    message(
      SYNTHETIC_IDS.messages.unknownProvider,
      SYNTHETIC_IDS.sessions.alphaRoot,
      nowMs - 30 * 60_000,
      151,
      { id: SYNTHETIC_ANALYTICS.models.openaiMini },
    ),
  ];
  const compactions = [
    {
      id: SYNTHETIC_IDS.compaction,
      sessionID: SYNTHETIC_IDS.sessions.alphaChild2,
      createdMs: nowMs - 9 * DAY_MS + HOUR_MS,
    },
  ];
  return { projects, projectDirectories, worktrees, sessions, messages, compactions };
}

function messageData(row) {
  const data = { time: { created: row.createdMs, completed: row.completedMs } };
  if (row.model) {
    const model = { id: row.model.id };
    if (row.model.providerID !== undefined) model.providerID = row.model.providerID;
    data.model = model;
  }
  if (row.tokens) {
    data.tokens = {
      input: row.tokens.input,
      output: row.tokens.output,
      reasoning: row.tokens.reasoning,
      cache: { read: row.tokens.cacheRead, write: row.tokens.cacheWrite },
    };
  }
  return JSON.stringify(data);
}

/**
 * Writes the synthetic `opencode.db` (same tables/columns as the test helper's
 * schema) and returns nothing; callers own the surrounding fixture root.
 */
export function writeSyntheticDatabase(dbPath, rows) {
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`
      CREATE TABLE "session_v2" (
        id TEXT PRIMARY KEY,
        title TEXT,
        parent_id TEXT,
        project_id TEXT,
        directory TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE "session_message" (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE "project" (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE "project_directory" (project_id TEXT NOT NULL, directory TEXT NOT NULL);
      CREATE TABLE "worktree" (project_id TEXT NOT NULL, directory TEXT NOT NULL, strategy TEXT);
    `);

    const insertSession = database.prepare(
      `INSERT INTO "session_v2" (id, title, parent_id, project_id, directory, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows.sessions) {
      insertSession.run(
        row.id,
        row.title ?? null,
        row.parentID ?? null,
        row.projectID ?? null,
        row.directory ?? null,
        row.createdMs,
        row.updatedMs ?? row.createdMs,
      );
    }

    const insertMessage = database.prepare(
      `INSERT INTO "session_message" (id, session_id, type, seq, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    rows.messages.forEach((row, index) => {
      insertMessage.run(
        row.id,
        row.sessionID,
        "assistant",
        index + 1,
        row.createdMs,
        row.completedMs,
        messageData(row),
      );
    });
    rows.compactions.forEach((row, index) => {
      insertMessage.run(
        row.id,
        row.sessionID,
        "compaction",
        rows.messages.length + index + 1,
        row.createdMs,
        row.createdMs,
        JSON.stringify({ time: { created: row.createdMs } }),
      );
    });

    const insertProject = database.prepare(`INSERT INTO "project" (id, name) VALUES (?, ?)`);
    for (const row of rows.projects) insertProject.run(row.id, row.name ?? null);

    const insertProjectDirectory = database.prepare(
      `INSERT INTO "project_directory" (project_id, directory) VALUES (?, ?)`,
    );
    for (const row of rows.projectDirectories) {
      insertProjectDirectory.run(row.projectID, row.directory);
    }

    const insertWorktree = database.prepare(
      `INSERT INTO "worktree" (project_id, directory, strategy) VALUES (?, ?, ?)`,
    );
    for (const row of rows.worktrees) {
      insertWorktree.run(row.projectID, row.directory, row.strategy);
    }
  } finally {
    database.close();
  }
}

/**
 * Seeds one complete synthetic home: workspace directories (including a legacy
 * project sidecar so import preview is exercised), the config dir, and the
 * database. Returns the paths the smoke process points itself at.
 */
export function seedSyntheticFixture(rootDir, nowMs) {
  const workspaceDir = join(rootDir, "workspace");
  const configDir = join(rootDir, "config");
  const dataDir = join(rootDir, "data");
  const workspaceRoot = join(workspaceDir, "alpha");

  for (const name of ["alpha", "alpha-wt", "alpha-wt2", "beta", "empty"]) {
    mkdirSync(join(workspaceDir, name), { recursive: true });
  }
  // A synthetic project marker so project-scope config resolution is unambiguous.
  mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
  mkdirSync(join(workspaceRoot, "opencode-quota"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  for (const name of ["xdg-config", "xdg-data", "xdg-cache", "xdg-state"]) {
    mkdirSync(join(rootDir, name), { recursive: true });
  }

  // Legacy (project) settings sidecar: import copies it into the global
  // canonical dashboard file; the sidecar itself is never written.
  writeFileSync(
    join(workspaceRoot, "opencode-quota", "quota-toast.jsonc"),
    `${JSON.stringify({ resetTimeDecimals: 2 }, null, 2)}\n`,
    "utf8",
  );

  const dbPath = join(dataDir, "opencode.db");
  writeSyntheticDatabase(dbPath, buildSyntheticRows(nowMs, workspaceDir));

  return { rootDir, dbPath, configDir, dataDir, workspaceDir, workspaceRoot, nowMs };
}

/**
 * One provider with two discovered accounts and a provider-reported currency
 * row. Plain DTOs only: no provider implementation, no credential, no network.
 */
export function buildSyntheticProviderProbes(nowMs) {
  const observedAtIso = new Date(nowMs).toISOString();
  return [
    {
      providerId: SYNTHETIC_PROVIDER_ID,
      result: {
        attempted: true,
        accounts: [
          { sourceId: SYNTHETIC_IDS.accounts.one, label: "Synthetic account one", active: true },
          { sourceId: SYNTHETIC_IDS.accounts.two, label: "Synthetic account two" },
        ],
        entries: [
          {
            kind: "percent",
            name: "Five hour quota",
            percentRemaining: 70,
            resetTimeIso: new Date(nowMs + 3 * HOUR_MS).toISOString(),
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
              sourceId: SYNTHETIC_IDS.accounts.one,
              observedAtIso,
            },
            semantic: { metric: { kind: "window", window: "five_hour" }, prominence: "primary" },
          },
          {
            kind: "percent",
            name: "Weekly quota",
            percentRemaining: 35,
            resetTimeIso: new Date(nowMs + 6 * DAY_MS).toISOString(),
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
              sourceId: SYNTHETIC_IDS.accounts.two,
              observedAtIso,
            },
            semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
          },
          {
            kind: "quantity",
            name: "Provider-reported credits",
            quantity: {
              decimal: SYNTHETIC_PROVIDER_AMOUNT,
              unit: { kind: "currency", code: "USD" },
            },
            accounting: {
              resultType: "balance",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
              observedAtIso,
            },
            semantic: {
              metric: { kind: "component", component: "remaining_credits" },
              prominence: "primary",
            },
          },
        ],
        errors: [],
      },
    },
  ];
}
