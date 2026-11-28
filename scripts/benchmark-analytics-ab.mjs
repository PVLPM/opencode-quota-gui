#!/usr/bin/env node
/**
 * Alternating A/B runner for the Analytics benchmark. Runs the same suite
 * version (scripts/benchmark-analytics.mjs) against two builds, interleaving
 * A, B, B, A, A, B, ... so drift (thermal, cache, background load) is spread
 * evenly, and writes one raw JSON per run plus a summary of distributions.
 *
 * Both builds see identical inputs: the suite isolates every XDG directory,
 * so each build prices with its own bundled `dist/data` snapshot (verify the
 * two are byte-identical before comparing costs), and each run generates its
 * synthetic source from the fixed seed. Real-local runs open the OpenCode
 * database read-only.
 *
 * Usage:
 *   node scripts/benchmark-analytics-ab.mjs --a <dist-root> --b <dist-root> \
 *     [--a-label baseline] [--b-label candidate] [--runs 5] [--runtime bun|node] \
 *     [--out docs/performance/local/runs/<name>] [-- <suite args...>]
 *
 * Results stay local (docs/performance/local/ is gitignored).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parse(argv) {
  const options = {
    a: null,
    b: null,
    aLabel: "baseline",
    bLabel: "candidate",
    runs: 5,
    runtime: "bun",
    out: null,
    suite: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`missing value for ${argument}`);
      return argv[index];
    };
    if (argument === "--") {
      options.suite = argv.slice(index + 1);
      break;
    } else if (argument === "--a") options.a = resolve(next());
    else if (argument === "--b") options.b = resolve(next());
    else if (argument === "--a-label") options.aLabel = next();
    else if (argument === "--b-label") options.bLabel = next();
    else if (argument === "--runs") options.runs = Number(next());
    else if (argument === "--runtime") options.runtime = next();
    else if (argument === "--out") options.out = resolve(next());
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!options.a || !options.b) throw new Error("--a and --b are required");
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("bad --runs");
  if (options.runtime !== "bun" && options.runtime !== "node") throw new Error("bad --runtime");
  options.out ??= join(repoRoot, "docs/performance/local/runs", `ab-${Date.now()}`);
  return options;
}

/** A B B A A B B A ...: each build leads equally often. */
function schedule(runs) {
  const order = [];
  for (let run = 0; run < runs; run += 1) {
    order.push(...(run % 2 === 0 ? ["a", "b"] : ["b", "a"]));
  }
  return order;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function distribution(values) {
  const sorted = values.filter((value) => typeof value === "number").sort((x, y) => x - y);
  if (sorted.length === 0) return null;
  const round = (value) => Math.round(value * 100) / 100;
  return {
    n: sorted.length,
    min: round(sorted[0]),
    p50: round(quantile(sorted, 0.5)),
    p90: round(quantile(sorted, 0.9)),
    max: round(sorted[sorted.length - 1]),
  };
}

/** Flatten the per-profile metrics that the comparison reports. */
function metricsOf(profile) {
  const metrics = {};
  for (const [key, value] of Object.entries(profile.durationsMs ?? {})) {
    metrics[`ms.${key}`] = value;
  }
  for (const [name, scenario] of Object.entries(profile.deltas?.scenarios ?? {})) {
    metrics[`writeBytes.delta.${name}`] = scenario.writeBytes;
  }
  const persistence = profile.persistence ?? {};
  metrics["writeBytes.coldThroughClose"] = persistence.coldWriteBytes;
  metrics["bytes.afterCold.total"] = persistence.afterColdClose?.totalBytes;
  metrics["bytes.afterDeltas.total"] = persistence.afterDeltasClose?.totalBytes;
  const worker = profile.memory?.worker ?? {};
  metrics["mib.worker.peakHeapUsed"] = worker.peakHeapUsedMiB;
  metrics["mib.worker.peakRss"] = worker.peakRssMiB;
  metrics["mib.worker.retainedDelta"] = worker.retainedDeltaMiB;
  return metrics;
}

function main() {
  const options = parse(process.argv.slice(2));
  mkdirSync(options.out, { recursive: true });
  const builds = {
    a: { root: options.a, label: options.aLabel },
    b: { root: options.b, label: options.bLabel },
  };
  for (const build of Object.values(builds)) {
    if (!existsSync(join(build.root, "dist/gui/analytics-worker.js"))) {
      throw new Error(`no dist build under ${build.label}`);
    }
  }
  // On Windows an npm `bun.cmd` shim cannot be spawned without a shell; set
  // BUN_BINARY to the real executable there.
  const command = options.runtime === "bun" ? (process.env.BUN_BINARY ?? "bun") : process.execPath;
  const runs = [];
  schedule(options.runs).forEach((key, index) => {
    const build = builds[key];
    const file = join(options.out, `${String(index).padStart(3, "0")}-${build.label}.json`);
    const started = Date.now();
    const child = spawnSync(
      command,
      [
        join(repoRoot, "scripts/benchmark-analytics.mjs"),
        ...options.suite,
        "--dist-root",
        build.root,
        "--label",
        build.label,
        "--json-out",
        file,
      ],
      { encoding: "utf8", cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    const failedChecks = /Failed checks: (.*)/.exec(child.stderr ?? "")?.[1] ?? null;
    runs.push({
      index,
      label: build.label,
      exit: child.status,
      wallMs: Date.now() - started,
      failedChecks,
      file,
    });
    process.stderr.write(
      `[${index + 1}/${options.runs * 2}] ${build.label} exit=${child.status} ${Math.round((Date.now() - started) / 1000)}s${failedChecks ? ` failed=${failedChecks}` : ""}\n`,
    );
  });

  /** Get-or-create one nested bucket. */
  const bucket = (parent, key, make) => {
    if (!Object.hasOwn(parent, key)) parent[key] = make();
    return parent[key];
  };
  const byLabel = {};
  for (const run of runs) {
    if (!existsSync(run.file)) continue;
    const result = JSON.parse(readFileSync(run.file, "utf8"));
    for (const profile of result.profiles ?? []) {
      const target = bucket(
        bucket(byLabel, profile.name, () => ({})),
        run.label,
        () => ({}),
      );
      for (const [metric, value] of Object.entries(metricsOf(profile))) {
        bucket(target, metric, () => []).push(value);
      }
      const checks = bucket(target, "checks.failed", () => []);
      for (const [check, value] of Object.entries(profile.checks ?? {})) {
        if (value === false) checks.push(check);
      }
    }
  }
  const summary = { runtime: options.runtime, runs, profiles: {} };
  for (const [profile, labels] of Object.entries(byLabel)) {
    summary.profiles[profile] = {};
    for (const [label, metrics] of Object.entries(labels)) {
      const entry = {};
      for (const [metric, values] of Object.entries(metrics)) {
        entry[metric] = metric === "checks.failed" ? values : distribution(values);
      }
      summary.profiles[profile][label] = entry;
    }
  }
  writeFileSync(join(options.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${join(options.out, "summary.json")}\n`);
}

main();
