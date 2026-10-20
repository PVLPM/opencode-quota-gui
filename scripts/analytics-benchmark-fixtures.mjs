/**
 * Deterministic synthetic fixtures for the analytics benchmark.
 *
 * Every profile is generated from a fixed seed into a disposable SQLite file.
 * The source clock is relative to the caller's run anchor, but every offset,
 * allocation, token value, model choice, fork copy, and compaction marker is a
 * deterministic function of that seed. No real database, path, title, content,
 * project, or credential is read or embedded.
 */

import { mkdirSync } from "node:fs";

export const DAY_MS = 24 * 3_600_000;
export const HOUR_MS = 3_600_000;
export const MIB = 1_048_576;

export const SYNTHETIC_PROFILES = {
  "dense-30d": {
    seed: 0x0d3e5e1,
    sessions: 420,
    rows: 128_000,
    projects: 10,
    spanDays: 45,
    tokenProfile: "dense-high-cache",
  },
  "long-lifetime": {
    seed: 0x10e6f1e,
    sessions: 180,
    rows: 54_000,
    projects: 6,
    spanDays: 540,
    tokenProfile: "long-lifetime",
  },
  "deep-session-tree": {
    seed: 0xdee9f0e,
    sessions: 47,
    rows: 6_690,
    projects: 3,
    spanDays: 150,
    tokenProfile: "growing-context",
  },
};

const PROVIDERS = [
  { providerID: "openai", modelID: "gpt-5" },
  { providerID: "anthropic", modelID: "claude-sonnet-4" },
  { providerID: "google", modelID: "gemini-2.5-pro" },
  { providerID: "synthetic", modelID: "hf:deepseek-ai/DeepSeek-V3.2" },
];

export function detectRuntime() {
  return typeof Bun !== "undefined" ? "bun" : "node";
}

/** Small deterministic PRNG (mulberry32). */
export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Open SQLite with an explicit writer/read-only role. */
export async function openDatabase(path, options = {}) {
  const readOnly = options.readOnly === true;
  if (detectRuntime() === "bun") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { readonly: readOnly });
    return readOnly ? wrapReadOnly(db) : db;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = readOnly
    ? new DatabaseSync(path, { readOnly: true, open: true })
    : new DatabaseSync(path);
  return readOnly ? wrapReadOnly(db) : db;
}

function wrapReadOnly(db) {
  const statement = (sql) => (typeof db.query === "function" ? db.query(sql) : db.prepare(sql));
  return {
    all(sql, params) {
      const prepared = statement(sql);
      return params === undefined ? prepared.all() : prepared.all(...params);
    },
    get(sql, params) {
      const prepared = statement(sql);
      return params === undefined ? prepared.get() : prepared.get(...params);
    },
    close() {
      db.close();
    },
  };
}

function createTables(db) {
  db.exec(`
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
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE "project" (id TEXT PRIMARY KEY, name TEXT, worktree TEXT);
    CREATE TABLE "project_directory" (project_id TEXT NOT NULL, directory TEXT NOT NULL);
    CREATE TABLE "worktree" (project_id TEXT NOT NULL, directory TEXT NOT NULL, strategy TEXT);
  `);
}

function prepareStatements(db) {
  return {
    session: db.prepare(
      `INSERT INTO "session_v2"
       (id, title, parent_id, project_id, directory, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    message: db.prepare(
      `INSERT INTO "session_message"
       (id, session_id, type, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    project: db.prepare(`INSERT INTO "project" (id, name, worktree) VALUES (?, ?, ?)`),
  };
}

function messageData(input) {
  return JSON.stringify({
    time: { created: input.created, completed: input.completed },
    model: { providerID: input.providerID, id: input.modelID },
    tokens: {
      input: input.input,
      output: input.output,
      reasoning: input.reasoning,
      cache: { read: input.cacheRead, write: input.cacheWrite },
    },
    cost: input.cost,
    agent: input.agent,
  });
}

function costOf(input) {
  return Number(
    (
      0.000001 *
      (input.input +
        input.output * 4 +
        input.reasoning * 2 +
        input.cacheRead * 0.1 +
        input.cacheWrite)
    ).toFixed(6),
  );
}

function denseTokens(random, step) {
  const input = 120 + Math.floor(random() * 460);
  const output = 40 + Math.floor(random() * 160);
  const reasoning = random() < 0.3 ? Math.floor(random() * 80) : 0;
  const cacheRead = 8_192 + Math.floor(random() * 32_768);
  const cacheWrite = 16 + Math.floor(random() * 320);
  return { input, output, reasoning, cacheRead, cacheWrite, step };
}

function longTokens(random) {
  const input = 200 + Math.floor(random() * 900);
  const output = 60 + Math.floor(random() * 300);
  const reasoning = random() < 0.2 ? Math.floor(random() * 120) : 0;
  const cacheRead = 2_048 + Math.floor(random() * 12_288);
  const cacheWrite = 32 + Math.floor(random() * 640);
  return { input, output, reasoning, cacheRead, cacheWrite };
}

function deepTokens(random, step) {
  const input = 150 + Math.floor(random() * 500);
  const output = 60 + Math.floor(random() * 240);
  const reasoning = random() < 0.25 ? Math.floor(random() * 120) : 0;
  // Context grows within the session, then plateaus, without requiring payload text.
  const cacheRead = 1_000 + Math.min(step * 420, 200_000) + Math.floor(random() * 1_200);
  const cacheWrite = 48 + Math.floor(random() * 512);
  return { input, output, reasoning, cacheRead, cacheWrite };
}

/** Largest-remainder allocation with a positive floor per entry. */
export function allocateCounts(total, weights, minimum = 1) {
  const length = weights.length;
  if (length === 0) return [];
  if (total < length * minimum) return new Array(length).fill(minimum);
  const base = new Array(length).fill(minimum);
  const remaining = total - length * minimum;
  const weightSum = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (weightSum <= 0) {
    return base.map((value, index) => value + (index < remaining ? 1 : 0));
  }
  const fractional = [];
  let assigned = 0;
  for (let index = 0; index < length; index += 1) {
    const exact = (remaining * Math.max(0, weights[index])) / weightSum;
    const floor = Math.floor(exact);
    base[index] += floor;
    assigned += floor;
    fractional.push({ index, fraction: exact - floor });
  }
  fractional.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < remaining - assigned; index += 1) {
    base[fractional[index % length].index] += 1;
  }
  return base;
}

function projectRows(profileName, count) {
  return Array.from({ length: count }, (_, index) => {
    const id = `proj_bench_${profileName.replace(/[^a-z0-9]/gi, "_")}_${index}`;
    return {
      id,
      name: `Synthetic project ${index + 1}`,
      worktree: `C:\\synthetic\\${profileName}-${index + 1}`,
    };
  });
}

function sessionId(profileName, index) {
  return `ses_bench_${profileName.replace(/[^a-z0-9]/gi, "_")}_${String(index).padStart(5, "0")}`;
}

function messageId(profileName, sessionIndex, messageIndex) {
  return `msg_bench_${profileName.replace(/[^a-z0-9]/gi, "_")}_${String(sessionIndex).padStart(5, "0")}_${String(messageIndex).padStart(6, "0")}`;
}

function baseSession(session) {
  return {
    id: session.id,
    parentID: session.parentID ?? null,
    projectID: session.projectID,
    directory: `C:\\synthetic\\${session.projectID}`,
    createdMs: Math.floor(session.createdMs),
    updatedMs: Math.floor(session.updatedMs),
  };
}

function insertGeneratedSession(statements, _profileName, index, session) {
  statements.session.run(
    session.id,
    `Synthetic session ${index + 1}`,
    session.parentID ?? null,
    session.projectID,
    session.directory,
    session.createdMs,
    session.updatedMs,
  );
}

function insertAssistant(statements, profileName, sessionIndex, messageIndex, input) {
  statements.message.run(
    messageId(profileName, sessionIndex, messageIndex),
    input.sessionID,
    "assistant",
    Math.floor(input.created),
    Math.floor(input.completed),
    messageData(input),
  );
}

function insertCompaction(statements, sessionID, atMs, label) {
  statements.message.run(
    `msg_bench_${label}`,
    sessionID,
    "compaction",
    Math.floor(atMs),
    Math.floor(atMs),
    JSON.stringify({ time: { created: Math.floor(atMs) } }),
  );
}

function buildDense(profileName, config, anchorMs, random, statements) {
  const projects = projectRows(profileName, config.projects);
  const sessions = [];
  const rowsBySession = new Map();
  const recentBySession = new Map();
  let cacheReadTokens = 0;
  const recentCutoff = anchorMs - 30 * DAY_MS;

  for (let index = 0; index < config.sessions; index += 1) {
    let projectID;
    if (index < 15) projectID = projects[0].id;
    else if (random() < 0.3) projectID = projects[0].id;
    else projectID = projects[1 + Math.floor(random() * (projects.length - 1))].id;

    let parentID = null;
    let ageDays;
    if (index === 0) {
      ageDays = 44;
    } else if (index <= 12) {
      parentID = sessions[0].id;
      ageDays = 40 - (index % 8);
    } else if (index <= 14) {
      parentID = sessions[1].id;
      ageDays = 24 - (index - 13) * 4;
    } else {
      ageDays = random() < 0.82 ? random() * 30 : 30 + random() * 15;
    }
    const createdMs = anchorMs - ageDays * DAY_MS - Math.floor(random() * DAY_MS);
    const spanDays = index === 0 ? 43 : 1 + random() * 11;
    const updatedMs = Math.min(
      anchorMs - 60_000,
      createdMs + spanDays * DAY_MS + Math.floor(random() * HOUR_MS),
    );
    const session = baseSession({
      id: sessionId(profileName, index),
      parentID,
      projectID,
      createdMs,
      updatedMs,
      directory: `C:\\synthetic\\${projectID}`,
    });
    sessions.push(session);
  }

  const weights = sessions.map(
    (session) => (0.5 + random() * 1.5) * (session.projectID === projects[0].id ? 2.8 : 1),
  );
  const counts = allocateCounts(config.rows, weights);

  for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
    const session = sessions[sessionIndex];
    const count = counts[sessionIndex];
    let latest = session.createdMs;
    for (let messageIndex = 0; messageIndex < count; messageIndex += 1) {
      const completed = Math.floor(
        session.createdMs + (session.updatedMs - session.createdMs) * random(),
      );
      const created = completed - 5_000 - Math.floor(random() * 300_000);
      const tokenIndex = (sessionIndex + messageIndex) % PROVIDERS.length;
      const model = PROVIDERS[tokenIndex];
      const tokens = denseTokens(random, messageIndex);
      const cost = costOf(tokens);
      insertAssistant(statements, profileName, sessionIndex, messageIndex, {
        sessionID: session.id,
        created,
        completed,
        providerID: model.providerID,
        modelID: model.modelID,
        ...tokens,
        cost,
        agent: messageIndex % 11 === 0 ? "plan" : "build",
      });
      cacheReadTokens += tokens.cacheRead;
      if (completed >= recentCutoff) {
        recentBySession.set(session.id, (recentBySession.get(session.id) ?? 0) + 1);
      }
      if (completed > latest) latest = completed;
    }
    rowsBySession.set(session.id, count);
    session.updatedMs = Math.max(session.updatedMs, latest);
  }

  return { projects, sessions, rowsBySession, recentBySession, cacheReadTokens };
}

function buildLongLifetime(profileName, config, anchorMs, random, statements) {
  const projects = projectRows(profileName, config.projects);
  const sessions = [];
  const rowsBySession = new Map();
  const recentBySession = new Map();
  let cacheReadTokens = 0;
  const recentCutoff = anchorMs - 30 * DAY_MS;

  for (let index = 0; index < config.sessions; index += 1) {
    const projectID = index < 8 ? projects[0].id : projects[index % projects.length].id;
    let parentID = null;
    if (index > 0 && index < 8) parentID = sessions[0].id;
    const ageDays =
      index === 0
        ? config.spanDays * 0.9
        : index < 8
          ? config.spanDays * (0.6 + index * 0.03)
          : random() * config.spanDays;
    const createdMs = anchorMs - ageDays * DAY_MS - Math.floor(random() * DAY_MS);
    const activeDays = Math.min(ageDays, 30 + random() * 240);
    const updatedMs = Math.min(
      anchorMs - 60_000,
      createdMs + activeDays * DAY_MS + Math.floor(random() * HOUR_MS),
    );
    sessions.push(
      baseSession({
        id: sessionId(profileName, index),
        parentID,
        projectID,
        createdMs,
        updatedMs,
      }),
    );
  }

  const weights = sessions.map(() => 0.6 + random() * 1.6);
  const counts = allocateCounts(config.rows, weights);

  for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
    const session = sessions[sessionIndex];
    const count = counts[sessionIndex];
    let latest = session.createdMs;
    for (let messageIndex = 0; messageIndex < count; messageIndex += 1) {
      const completed = Math.floor(
        session.createdMs + (session.updatedMs - session.createdMs) * random(),
      );
      const created = completed - 5_000 - Math.floor(random() * 600_000);
      const model = PROVIDERS[(sessionIndex + messageIndex) % PROVIDERS.length];
      const tokens = longTokens(random);
      const cost = costOf(tokens);
      insertAssistant(statements, profileName, sessionIndex, messageIndex, {
        sessionID: session.id,
        created,
        completed,
        providerID: model.providerID,
        modelID: model.modelID,
        ...tokens,
        cost,
        agent: messageIndex % 7 === 0 ? "plan" : "build",
      });
      cacheReadTokens += tokens.cacheRead;
      if (completed >= recentCutoff) {
        recentBySession.set(session.id, (recentBySession.get(session.id) ?? 0) + 1);
      }
      if (completed > latest) latest = completed;
    }
    rowsBySession.set(session.id, count);
    session.updatedMs = Math.max(session.updatedMs, latest);
  }

  return { projects, sessions, rowsBySession, recentBySession, cacheReadTokens };
}

function deepSessionSpecs(profileName, projects, anchorMs, random) {
  const specs = [];
  const root = {
    id: sessionId(profileName, 0),
    projectID: projects[0].id,
    parentID: null,
    weight: 1200,
    depth: 0,
    createdMs: anchorMs - 150 * DAY_MS,
    updatedMs: anchorMs - DAY_MS,
  };
  specs.push(root);

  const level1 = [];
  for (let index = 0; index < 6; index += 1) {
    const createdMs = anchorMs - (140 - index * 3) * DAY_MS;
    const session = {
      id: sessionId(profileName, specs.length),
      projectID: projects[0].id,
      parentID: root.id,
      weight: 650,
      depth: 1,
      createdMs,
      updatedMs: Math.min(anchorMs - (4 + index) * DAY_MS, createdMs + 90 * DAY_MS),
    };
    level1.push(session);
    specs.push(session);
  }

  const level2 = [];
  for (let index = 0; index < 18; index += 1) {
    const parent = level1[index % level1.length];
    const createdMs = Math.min(
      anchorMs - 60 * DAY_MS,
      parent.createdMs + (5 + random() * 20) * DAY_MS,
    );
    const session = {
      id: sessionId(profileName, specs.length),
      projectID: projects[0].id,
      parentID: parent.id,
      weight: 60,
      depth: 2,
      createdMs,
      updatedMs: Math.max(createdMs + DAY_MS, anchorMs - (5 + random() * 20) * DAY_MS),
    };
    level2.push(session);
    specs.push(session);
  }

  const level3 = [];
  for (let index = 0; index < 12; index += 1) {
    const parent = level2[index % level2.length];
    const createdMs = Math.min(
      anchorMs - 24 * DAY_MS,
      parent.createdMs + (2 + random() * 10) * DAY_MS,
    );
    const session = {
      id: sessionId(profileName, specs.length),
      projectID: projects[0].id,
      parentID: parent.id,
      weight: 25,
      depth: 3,
      createdMs,
      updatedMs: Math.max(createdMs + HOUR_MS, anchorMs - (2 + random() * 14) * DAY_MS),
    };
    level3.push(session);
    specs.push(session);
  }

  const level4 = [];
  for (let index = 0; index < 6; index += 1) {
    const parent = level3[index % level3.length];
    const createdMs = Math.min(
      anchorMs - 12 * DAY_MS,
      parent.createdMs + (1 + random() * 5) * DAY_MS,
    );
    const session = {
      id: sessionId(profileName, specs.length),
      projectID: projects[0].id,
      parentID: parent.id,
      weight: 25,
      depth: 4,
      createdMs,
      updatedMs: Math.max(createdMs + HOUR_MS, anchorMs - (1 + random() * 8) * DAY_MS),
    };
    level4.push(session);
    specs.push(session);
  }

  for (let index = 0; index < 2; index += 1) {
    const parent = level4[index % level4.length];
    const createdMs = Math.min(
      anchorMs - 6 * DAY_MS,
      parent.createdMs + (1 + random() * 3) * DAY_MS,
    );
    specs.push({
      id: sessionId(profileName, specs.length),
      projectID: projects[0].id,
      parentID: parent.id,
      weight: 30,
      depth: 5,
      createdMs,
      updatedMs: Math.max(createdMs + HOUR_MS, anchorMs - (1 + random() * 4) * DAY_MS),
    });
  }
  return { specs, root, level2 };
}

function buildDeep(profileName, config, anchorMs, random, statements) {
  const projects = projectRows(profileName, config.projects);
  const { specs, root } = deepSessionSpecs(profileName, projects, anchorMs, random);
  const sessions = specs.map((spec) => baseSession(spec));
  const rowsBySession = new Map();
  const recentBySession = new Map();
  let cacheReadTokens = 0;

  const counts = allocateCounts(
    config.rows,
    specs.map((spec) => spec.weight),
  );
  const sourceMessages = [];
  const sourceSession = specs[1];

  for (let sessionIndex = 0; sessionIndex < specs.length; sessionIndex += 1) {
    const spec = specs[sessionIndex];
    const session = sessions[sessionIndex];
    const count = counts[sessionIndex];
    let latest = spec.createdMs;
    for (let messageIndex = 0; messageIndex < count; messageIndex += 1) {
      let completed;
      if (sessionIndex === 0 && messageIndex >= count - 4) {
        completed = anchorMs - (messageIndex - (count - 4) + 1) * 2 * HOUR_MS;
      } else {
        completed = Math.floor(spec.createdMs + (spec.updatedMs - spec.createdMs) * random());
      }
      const created = completed - 5_000 - Math.floor(random() * 240_000);
      const model = PROVIDERS[(sessionIndex + messageIndex) % PROVIDERS.length];
      const tokens = deepTokens(random, messageIndex);
      const cost = costOf(tokens);
      const row = {
        sessionID: session.id,
        created,
        completed,
        providerID: model.providerID,
        modelID: model.modelID,
        ...tokens,
        cost,
        agent: messageIndex % 9 === 0 ? "plan" : "build",
      };
      insertAssistant(statements, profileName, sessionIndex, messageIndex, row);
      cacheReadTokens += tokens.cacheRead;
      if (completed >= anchorMs - 30 * DAY_MS) {
        recentBySession.set(session.id, (recentBySession.get(session.id) ?? 0) + 1);
      }
      if (session.id === sourceSession.id && sourceMessages.length < 150) {
        sourceMessages.push(row);
      }
      if (completed > latest) latest = completed;
    }
    rowsBySession.set(session.id, count);
    session.updatedMs = Math.max(session.updatedMs, latest);
  }

  // Two fork sessions copy finished parent rows with new ids but identical
  // times/tokens/cost/model, exercising fork-copy ownership accounting.
  for (let forkIndex = 0; forkIndex < 2; forkIndex += 1) {
    const forkSession = baseSession({
      id: sessionId(profileName, specs.length + forkIndex),
      parentID: sourceSession.id,
      projectID: sourceSession.projectID,
      createdMs: sourceSession.createdMs + forkIndex * DAY_MS,
      updatedMs: sourceSession.updatedMs,
    });
    sessions.push(forkSession);
    for (let copyIndex = 0; copyIndex < sourceMessages.length; copyIndex += 1) {
      const source = sourceMessages[copyIndex];
      insertAssistant(statements, profileName, specs.length + forkIndex, copyIndex, {
        ...source,
        sessionID: forkSession.id,
      });
    }
    rowsBySession.set(forkSession.id, sourceMessages.length);
  }

  // Compaction markers inside the large tree.
  const compactionTimes = [90, 60, 30, 10].map((days) => anchorMs - days * DAY_MS);
  for (const atMs of compactionTimes) {
    insertCompaction(statements, root.id, atMs, `${profileName}_root_${atMs}`);
  }
  const child = specs[1];
  for (const [index, days] of [45, 15].entries()) {
    insertCompaction(
      statements,
      child.id,
      anchorMs - days * DAY_MS,
      `${profileName}_child_${index}_${days}`,
    );
  }

  return {
    projects,
    sessions,
    rowsBySession,
    recentBySession,
    cacheReadTokens,
    forks: 2,
    compactions: compactionTimes.length + 2,
  };
}

/**
 * Build one synthetic profile and return its disposable database plus an
 * anonymous summary and internal selection ids (never serialized).
 */
export async function createSyntheticDatabase(options) {
  const { profileName, root, anchorMs } = options;
  const config = { ...SYNTHETIC_PROFILES[profileName], ...(options.overrides ?? {}) };
  if (!config || !config.sessions) throw new Error("unknown-profile");
  mkdirSync(root, { recursive: true });
  const random = createSeededRandom(config.seed);
  const dbPath = `${root}/opencode.db`;
  const db = await openDatabase(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = OFF");
  createTables(db);
  const statements = prepareStatements(db);

  db.exec("BEGIN");
  for (const project of projectRows(profileName, config.projects)) {
    statements.project.run(project.id, project.name, project.worktree);
  }

  const built =
    profileName === "dense-30d"
      ? buildDense(profileName, config, anchorMs, random, statements)
      : profileName === "long-lifetime"
        ? buildLongLifetime(profileName, config, anchorMs, random, statements)
        : buildDeep(profileName, config, anchorMs, random, statements);

  for (let index = 0; index < built.sessions.length; index += 1) {
    insertGeneratedSession(statements, profileName, index, built.sessions[index]);
  }

  db.exec("COMMIT");
  db.close();

  const graph = analyzeSessionGraph(built.sessions, built.rowsBySession, built.recentBySession);
  const selection = selectFromGraph(graph, built.rowsBySession);
  const totalRows = [...built.rowsBySession.values()].reduce((sum, value) => sum + value, 0);
  const spanDays = round(
    (Math.max(...built.sessions.map((session) => session.updatedMs)) -
      Math.min(...built.sessions.map((session) => session.createdMs))) /
      DAY_MS,
    1,
  );

  return {
    dbPath,
    graph,
    selection,
    synthetic: {
      profile: profileName,
      seed: config.seed,
      sessions: built.sessions.length,
      rows: totalRows,
      projects: built.projects.length,
      spanDays,
      tokenProfile: config.tokenProfile,
      cacheReadTokens: built.cacheReadTokens,
      forks: built.forks ?? 0,
      compactions: built.compactions ?? 0,
      treeRows: selection.summary.largestTree.rows,
      treeDescendants: selection.summary.largestTree.descendants,
      treeMaxDepth: selection.summary.largestTree.maxDepth,
    },
  };
}

/** Build a read-only analysis of sessions, trees, and project spans. */
export function analyzeSessionGraph(sessionRows, rowsBySession, recentBySession = new Map()) {
  const sessions = [];
  for (const row of sessionRows) {
    if (!row || typeof row.id !== "string" || !row.id.startsWith("ses_")) continue;
    const projectID =
      typeof row.projectID === "string" && row.projectID.trim() ? row.projectID.trim() : "unknown";
    const parentID =
      typeof row.parentID === "string" && row.parentID.trim() ? row.parentID.trim() : undefined;
    const createdMs =
      typeof row.createdMs === "number" && Number.isFinite(row.createdMs) ? row.createdMs : 0;
    const updatedMs =
      typeof row.updatedMs === "number" && Number.isFinite(row.updatedMs)
        ? row.updatedMs
        : createdMs;
    sessions.push({ id: row.id, parentID, projectID, createdMs, updatedMs });
  }

  const byProject = new Map();
  for (const session of sessions) {
    let list = byProject.get(session.projectID);
    if (!list) {
      list = [];
      byProject.set(session.projectID, list);
    }
    list.push(session);
  }

  const projects = [];
  for (const [projectID, projectSessions] of byProject) {
    const trees = buildTrees(projectSessions, rowsBySession);
    const rows = projectSessions.reduce(
      (sum, session) => sum + (rowsBySession.get(session.id) ?? 0),
      0,
    );
    const recentRows = projectSessions.reduce(
      (sum, session) => sum + (recentBySession.get(session.id) ?? 0),
      0,
    );
    const firstCreatedMs = Math.min(...projectSessions.map((session) => session.createdMs));
    const lastUpdatedMs = Math.max(...projectSessions.map((session) => session.updatedMs));
    projects.push({
      id: projectID,
      sessions: projectSessions.length,
      rows,
      recentRows,
      roots: trees.length,
      spanDays: round((lastUpdatedMs - firstCreatedMs) / DAY_MS, 1),
      firstCreatedMs,
      lastUpdatedMs,
      trees,
    });
  }

  projects.sort((a, b) => a.id.localeCompare(b.id));
  const trees = projects.flatMap((project) =>
    project.trees.map((tree) => ({ ...tree, projectID: project.id })),
  );
  trees.sort(
    (a, b) => b.members - a.members || b.rows - a.rows || a.rootId.localeCompare(b.rootId),
  );
  return {
    projects,
    trees,
    totalRows: sessions.reduce((sum, session) => sum + (rowsBySession.get(session.id) ?? 0), 0),
    totalSessions: sessions.length,
  };
}

function buildTrees(projectSessions, rowsBySession) {
  const byId = new Map(projectSessions.map((session) => [session.id, session]));
  const children = new Map();
  const roots = [];
  for (const session of projectSessions) {
    const parent = session.parentID;
    if (!parent || parent === session.id || !byId.has(parent)) {
      roots.push(session);
      continue;
    }
    let list = children.get(parent);
    if (!list) {
      list = [];
      children.set(parent, list);
    }
    list.push(session);
  }
  roots.sort((a, b) => a.id.localeCompare(b.id));

  const visited = new Set();
  const trees = [];
  const visit = (root) => {
    const members = [];
    const depths = new Map();
    const stack = [{ session: root, depth: 0 }];
    let maxDepth = 0;
    let deepestId = root.id;
    let deepestRows = -1;
    while (stack.length > 0) {
      const item = stack.pop();
      const { session, depth } = item;
      if (visited.has(session.id)) continue;
      visited.add(session.id);
      members.push(session.id);
      depths.set(session.id, depth);
      const rows = rowsBySession.get(session.id) ?? 0;
      if (depth > maxDepth || (depth === maxDepth && rows > deepestRows)) {
        maxDepth = depth;
        deepestId = session.id;
        deepestRows = rows;
      }
      for (const child of children.get(session.id) ?? []) {
        stack.push({ session: child, depth: depth + 1 });
      }
    }
    const rows = members.reduce((sum, id) => sum + (rowsBySession.get(id) ?? 0), 0);
    const subtreeSizes = new Map();
    const sizeOf = (id, visiting) => {
      if (subtreeSizes.has(id)) return subtreeSizes.get(id);
      if (visiting.has(id)) return 1;
      visiting.add(id);
      let size = 1;
      for (const child of children.get(id) ?? []) size += sizeOf(child.id, visiting);
      visiting.delete(id);
      subtreeSizes.set(id, size);
      return size;
    };
    sizeOf(root.id, new Set());
    trees.push({
      rootId: root.id,
      memberIds: members,
      members: members.length,
      descendants: members.length - 1,
      maxDepth,
      rows,
      rootRows: rowsBySession.get(root.id) ?? 0,
      deepestId,
      deepestRows: Math.max(0, deepestRows),
      depths,
      subtreeSizes,
    });
  };

  for (const root of roots) visit(root);
  // A parent cycle can leave unvisited sessions; each remaining component is
  // still measured as its own root without changing membership semantics.
  for (const session of projectSessions) {
    if (!visited.has(session.id)) {
      roots.push(session);
      visit(session);
    }
  }
  return trees;
}

/** Choose the anonymous workload targets from an analyzed graph. */
export function selectFromGraph(graph, rowsBySession) {
  const projects = [...graph.projects];
  const metrics = projects.map((project) => ({
    project,
    density: project.recentRows > 0 ? project.recentRows : project.rows,
  }));
  metrics.sort(
    (a, b) =>
      b.density - a.density ||
      b.project.rows - a.project.rows ||
      a.project.id.localeCompare(b.project.id),
  );
  const dense = metrics[0]?.project ?? {
    id: "unknown",
    sessions: 0,
    rows: 0,
    recentRows: 0,
    spanDays: 0,
    trees: [],
  };
  const longest =
    [...projects].sort(
      (a, b) => b.spanDays - a.spanDays || b.rows - a.rows || a.id.localeCompare(b.id),
    )[0] ?? dense;

  const denseSessions = [];
  for (const tree of dense.trees) {
    for (const id of tree.memberIds ?? []) denseSessions.push(id);
  }
  const targetSessionId =
    denseSessions
      .map((id) => ({ id, rows: rowsBySession.get(id) ?? 0 }))
      .sort((a, b) => b.rows - a.rows || a.id.localeCompare(b.id))[0]?.id ??
    graph.trees[0]?.rootId ??
    "";

  const largestTree = graph.trees[0] ?? {
    rootId: targetSessionId,
    members: 1,
    descendants: 0,
    maxDepth: 0,
    rows: rowsBySession.get(targetSessionId) ?? 0,
    rootRows: rowsBySession.get(targetSessionId) ?? 0,
    deepestId: targetSessionId,
    deepestRows: rowsBySession.get(targetSessionId) ?? 0,
    depths: new Map(),
    subtreeSizes: new Map(),
  };
  const subSessionCandidates = (largestTree.memberIds ?? [])
    .filter((id) => id !== largestTree.rootId)
    .map((id) => ({
      id,
      subtree: largestTree.subtreeSizes?.get(id) ?? 1,
      depth: largestTree.depths?.get(id) ?? 0,
    }));
  subSessionCandidates.sort(
    (a, b) => b.subtree - a.subtree || b.depth - a.depth || a.id.localeCompare(b.id),
  );
  const subSessionId = subSessionCandidates[0]?.id ?? largestTree.deepestId;

  const totalRows = graph.totalRows || 1;
  return {
    internal: {
      denseProjectId: dense.id,
      longProjectId: longest.id,
      largeTreeRootId: largestTree.rootId,
      subSessionId,
      deltaTargetSessionId: targetSessionId,
    },
    summary: {
      densestProject: {
        sessions: dense.sessions,
        rows: dense.rows,
        recentRows: dense.recentRows,
        sharePct: round((dense.rows / totalRows) * 100, 1),
        metric: dense.recentRows > 0 ? "assistant-rows-30d" : "assistant-rows-lifetime",
      },
      longestProject: {
        sessions: longest.sessions,
        rows: longest.rows,
        spanDays: longest.spanDays,
      },
      largestTree: {
        members: largestTree.members,
        descendants: largestTree.descendants,
        maxDepth: largestTree.maxDepth,
        rows: largestTree.rows,
        rootRows: largestTree.rootRows,
        deepestRows: largestTree.deepestRows,
        subSessionSubtreeMembers: largestTree.subtreeSizes?.get(subSessionId) ?? 1,
      },
    },
  };
}

/**
 * Append synthetic rows for one delta scenario. This is the only writer used
 * after the initial fixture build; real-local mode never calls it.
 */
export async function appendDeltaRows(options) {
  const { dbPath, targetSessionId, scenario, anchorMs } = options;
  const definitions = {
    add100: { rows: 100, days: 1 },
    add1000: { rows: 1_000, days: 1 },
    twoDay: { rows: 400, days: 2 },
    coldResume: { rows: 400, days: 2 },
  };
  const definition = definitions[scenario];
  if (!definition) throw new Error("unknown-delta");
  const db = await openDatabase(dbPath);
  const insert = db.prepare(
    `INSERT INTO "session_message"
     (id, session_id, type, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  let inserted = 0;
  try {
    if (scenario === "twoDay" || scenario === "coldResume") {
      for (let day = 0; day < definition.days; day += 1) {
        for (let index = 0; index < definition.rows / definition.days; index += 1) {
          const completed = anchorMs - (day + 1) * 6 * HOUR_MS - index * 1_000;
          const created = completed - 2_000;
          const provider = PROVIDERS[day % PROVIDERS.length];
          insert.run(
            `msg_bench_delta_${scenario}_${day}_${index}`,
            targetSessionId,
            "assistant",
            Math.floor(created),
            Math.floor(completed),
            JSON.stringify({
              time: { created: Math.floor(created), completed: Math.floor(completed) },
              model: { providerID: provider.providerID, id: provider.modelID },
              tokens: {
                input: 40 + index,
                output: 10 + (index % 7),
                reasoning: 0,
                cache: { read: 1_000 + index * 2, write: 4 },
              },
              cost: 0.000001 * (index + 1),
              agent: "build",
            }),
          );
          inserted += 1;
        }
      }
    } else {
      for (let index = 0; index < definition.rows; index += 1) {
        const completed = anchorMs - 60_000 - index * 100;
        const created = completed - 1_000;
        const provider = PROVIDERS[index % PROVIDERS.length];
        insert.run(
          `msg_bench_delta_${scenario}_${index}`,
          targetSessionId,
          "assistant",
          Math.floor(created),
          Math.floor(completed),
          JSON.stringify({
            time: { created: Math.floor(created), completed: Math.floor(completed) },
            model: { providerID: provider.providerID, id: provider.modelID },
            tokens: {
              input: 50 + (index % 31),
              output: 12 + (index % 13),
              reasoning: index % 5,
              cache: { read: 1_500 + (index % 97) * 13, write: 8 },
            },
            cost: 0.000001 * (index + 1),
            agent: "build",
          }),
        );
        inserted += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failure.
    }
    throw error;
  } finally {
    db.close();
  }
  return { insertedRows: inserted, days: definition.days };
}

export function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
