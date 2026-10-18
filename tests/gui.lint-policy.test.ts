import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PackageManifest {
  engines?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

interface LockfileDependency {
  specifier?: string;
  version?: string;
}

interface Lockfile {
  importers?: { "."?: { devDependencies?: Record<string, LockfileDependency> } };
}

interface OxlintPluginEntry {
  name?: string;
  specifier?: string;
}

interface OxlintOverride {
  files?: string[];
  rules?: Record<string, string>;
}

interface OxlintConfig {
  jsPlugins?: OxlintPluginEntry[];
  ignorePatterns?: string[];
  rules?: Record<string, string>;
  overrides?: OxlintOverride[];
}

interface OxlintTsconfig {
  compilerOptions?: {
    outDir?: string;
    rootDir?: string;
    rewriteRelativeImportExtensions?: boolean;
    skipLibCheck?: boolean;
  };
  include?: string[];
}

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  "continue-on-error"?: boolean;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

interface VendorManifest {
  paths: string[];
  sha256: string;
}

const OXLINT_VERSION = "1.88.0";
const OXLINT_PLUGINS_VERSION = "1.88.0";
const KNIP_VERSION = "6.41.0";
const PLUGIN_SPECIFIER = "./node_modules/.cache/oxlint-anti-slop/index.js";
// SHA-256 of the canonical pristine manifest of the 26 vendored TypeScript
// files: ordinal sort of forward-slash paths, `path<TAB>sha256(file)<LF>`.
const PRISTINE_MANIFEST_SHA256 = "ab89fcc42088f6c2bf9952b24837ebe449e1c9c8374bc1b1c2da649232ea8502";
const ANTI_SLOP_RULES = [
  "anti-slop/no-array-filter-map",
  "anti-slop/no-reduce-accumulator-copy",
  "anti-slop/no-chained-type-assertions",
  "anti-slop/no-conditional-empty-object-spread",
  "anti-slop/no-known-value-widening",
  "anti-slop/no-module-mocking",
  "anti-slop/no-object-parameters",
  "anti-slop/no-reflect-apply",
  "anti-slop/no-reflect-get",
  "anti-slop/no-runtime-typeof",
  "anti-slop/no-shape-in-symbol-names",
  "anti-slop/no-unknown-parameters",
  "anti-slop/no-unknown-returns",
  "anti-slop/no-unknown-type-aliases",
  "anti-slop/no-unsafe-dictionary-type",
  "anti-slop/no-widen-then-assert",
  "anti-slop/require-safety-comment-for-type-assertion",
];
const EXPECTED_RULE_KEYS = [...ANTI_SLOP_RULES, "oxc/no-accumulating-spread"];

function readText(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function sha256Hex(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function forEachJobStep(workflow: Workflow, visit: (step: WorkflowStep) => void): void {
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) visit(step);
  }
}

const manifest: PackageManifest = JSON.parse(readText("package.json"));
const lockfile: Lockfile = parse(readText("pnpm-lock.yaml"));
const oxlintConfig: OxlintConfig = JSON.parse(readText("oxlint.json"));
const oxlintTsconfig: OxlintTsconfig = JSON.parse(readText("tsconfig.oxlint.json"));
const ciWorkflow: Workflow = parse(readText(".github/workflows/ci.yml"));
const lintRunner = readText("scripts/run-oxlint-anti-slop.mjs");
const vendorRoot = path.join(repoRoot, "tools", "oxlint-anti-slop");

function vendorEntries(): string[] {
  return readdirSync(vendorRoot, { recursive: true, encoding: "utf8" }).flatMap((entry) =>
    statSync(path.join(vendorRoot, entry)).isFile() ? [entry] : [],
  );
}

function canonicalVendorManifest(): VendorManifest {
  const paths = readdirSync(vendorRoot, { recursive: true, encoding: "utf8" })
    .flatMap((entry) => (entry.endsWith(".ts") ? [entry.replaceAll("\\", "/")] : []))
    .sort();
  const lines = paths.map((vendorPath) => {
    const bytes = readFileSync(path.join(vendorRoot, ...vendorPath.split("/")));
    return `${vendorPath}\t${sha256Hex(bytes)}\n`;
  });
  return { paths, sha256: sha256Hex(lines.join("")) };
}

describe("GUI lint policy (R40, R41)", () => {
  it("pins oxlint and @oxlint/plugins to the same exact version and knip exactly", () => {
    expect(manifest.devDependencies?.oxlint).toBe(OXLINT_VERSION);
    expect(manifest.devDependencies?.["@oxlint/plugins"]).toBe(OXLINT_PLUGINS_VERSION);
    expect(manifest.devDependencies?.knip).toBe(KNIP_VERSION);
    expect(OXLINT_VERSION).toBe(OXLINT_PLUGINS_VERSION);

    const locked = lockfile.importers?.["."]?.devDependencies;
    expect(locked?.oxlint?.specifier).toBe(OXLINT_VERSION);
    expect(locked?.oxlint?.version).toBe(OXLINT_VERSION);
    expect(locked?.["@oxlint/plugins"]?.specifier).toBe(OXLINT_PLUGINS_VERSION);
    expect(locked?.["@oxlint/plugins"]?.version).toBe(OXLINT_PLUGINS_VERSION);
    expect(locked?.knip?.specifier).toBe(KNIP_VERSION);
    expect(locked?.knip?.version).toBe(KNIP_VERSION);
  });

  it("vendors the pristine 26-file plugin with its full MIT license and public provenance", () => {
    const entries = vendorEntries().sort();
    expect(entries.filter((entry) => !entry.endsWith(".ts"))).toEqual(["LICENSE", "UPSTREAM.md"]);

    const { paths, sha256 } = canonicalVendorManifest();
    expect(paths).toHaveLength(26);
    expect(sha256).toBe(PRISTINE_MANIFEST_SHA256);

    const license = readText("tools/oxlint-anti-slop/LICENSE");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 Dillon Mulroy");
    expect(license).toContain("Permission is hereby granted");
    expect(license).toContain("THE SOFTWARE IS PROVIDED");

    const upstream = readText("tools/oxlint-anti-slop/UPSTREAM.md");
    expect(upstream).toContain("https://github.com/dmmulroy/anti-slop");
    expect(upstream).toContain("MIT");
    expect(upstream).toContain(PRISTINE_MANIFEST_SHA256);
    expect(upstream).toContain("2026-10-18");
    expect(upstream.toLowerCase()).toContain("unknown");
    // No guessed commit and no local machine paths may appear in provenance.
    expect(upstream).not.toMatch(/\b[0-9a-f]{40}\b/u);
    expect(upstream).not.toMatch(/[\s(][A-Za-z]:[\\/]/u);
  });

  it("loads the compiled plugin through the cache alias and leaves Effect rules opt-in only", () => {
    expect(oxlintConfig.jsPlugins).toEqual([{ name: "anti-slop", specifier: PLUGIN_SPECIFIER }]);
    const ruleKeys = Object.keys(oxlintConfig.rules ?? {});
    expect(ruleKeys.some((rule) => rule.startsWith("anti-slop-effect/"))).toBe(false);
    expect(manifest.devDependencies).not.toHaveProperty("effect");
  });

  it("compiles the vendored TypeScript with TS7 into a git-ignored cache, never with a loader", () => {
    expect(oxlintTsconfig.compilerOptions?.outDir).toBe("node_modules/.cache/oxlint-anti-slop");
    expect(oxlintTsconfig.compilerOptions?.rootDir).toBe("tools/oxlint-anti-slop");
    expect(oxlintTsconfig.compilerOptions?.rewriteRelativeImportExtensions).toBe(true);
    expect(oxlintTsconfig.compilerOptions?.skipLibCheck).toBe(true);
    expect(oxlintTsconfig.include).toEqual(["tools/oxlint-anti-slop/**/*.ts"]);

    // The alias target is exactly the emitted index.js.
    const outDir = oxlintTsconfig.compilerOptions?.outDir ?? "";
    const rootDir = oxlintTsconfig.compilerOptions?.rootDir ?? "";
    const sourceIndex = path.posix.join(rootDir, "index.ts");
    const emittedIndex = path.posix.join(outDir, path.posix.relative(rootDir, sourceIndex));
    expect(`./${emittedIndex.replace(/\.ts$/u, ".js")}`).toBe(PLUGIN_SPECIFIER);

    // No Node floor change and no loader/compiler shim anywhere in the wiring.
    expect(manifest.engines?.node).toBe("^22.13.0 || >=23.4.0");
    const scripts = Object.values(manifest.scripts ?? {}).join("\n");
    for (const forbidden of ["NODE_OPTIONS", "--experimental", "--loader", "ts-node", "tsx "]) {
      expect(scripts).not.toContain(forbidden);
      expect(lintRunner).not.toContain(forbidden);
    }
    expect(manifest.devDependencies).not.toHaveProperty("tsx");
    expect(manifest.devDependencies).not.toHaveProperty("ts-node");
  });

  it("enables every generic anti-slop rule and the native companion at error", () => {
    const rules = oxlintConfig.rules ?? {};
    for (const rule of EXPECTED_RULE_KEYS) {
      expect(rules[rule], `rule ${rule} must be enabled`).toBe("error");
    }
    expect(Object.keys(rules).sort()).toEqual([...EXPECTED_RULE_KEYS].sort());
  });

  it("keeps no-console on new GUI source with src/gui/log.ts as the documented sink", () => {
    const overrides = oxlintConfig.overrides ?? [];
    const newSource = overrides.find((override) => override.files?.includes("src/gui/**/*.ts"));
    expect(newSource?.rules?.["no-console"]).toBe("error");
    const sink = overrides.find((override) => override.files?.includes("src/gui/log.ts"));
    expect(sink?.rules?.["no-console"]).toBe("off");
  });

  it("keeps the strict Oxlint sweep runnable outside the blocking verify chain", () => {
    expect(manifest.scripts?.["lint:oxlint"]).toBe("node scripts/run-oxlint-anti-slop.mjs");
    expect(manifest.scripts?.["lint:oxlint:upstream"]).toBe(
      "node scripts/run-oxlint-anti-slop.mjs --upstream",
    );
    expect(manifest.scripts?.knip).toBe("knip");

    // The runner invokes the real Oxlint binary with this config; it is not a
    // custom scanner and contains no regex rule machinery.
    expect(lintRunner).toContain("oxlint.json");
    expect(lintRunner).toContain("node_modules");
    expect(lintRunner).not.toContain("RegExp(");
    // Strict mode propagates Oxlint's exit code, so the command stays runnable as
    // a gate while the canonical verify chain links to it only advisorily.
    expect(lintRunner).toContain("process.exit(status)");

    const verify = manifest.scripts?.verify ?? "";
    expect(verify).not.toContain("lint:oxlint");
    expect(verify).not.toContain("knip");
  });

  it("keeps Oxlint and Knip advisory in CI while the blocking verify chain stays linter-free", () => {
    const oxlintSteps: WorkflowStep[] = [];
    const oxlintReports: WorkflowStep[] = [];
    forEachJobStep(ciWorkflow, (step) => {
      if (step.run === "pnpm run lint:oxlint") oxlintSteps.push(step);
      if (step.if === "${{ steps.oxlint-advisory.outcome == 'failure' }}") oxlintReports.push(step);
    });
    expect(oxlintSteps).toHaveLength(1);
    expect(oxlintSteps[0]?.id).toBe("oxlint-advisory");
    expect(oxlintSteps[0]?.["continue-on-error"]).toBe(true);
    expect(oxlintReports).toHaveLength(1);
    expect(oxlintReports[0]?.run).toContain("::warning title=Oxlint advisory::");

    const knipSteps: WorkflowStep[] = [];
    forEachJobStep(ciWorkflow, (step) => {
      if (step.run === "pnpm run knip") knipSteps.push(step);
    });
    expect(knipSteps).toHaveLength(1);
    expect(knipSteps[0]?.["continue-on-error"]).toBe(true);

    for (const rule of ["--fix"]) {
      expect(manifest.scripts?.knip).not.toContain(rule);
      expect(lintRunner).not.toContain(rule);
    }
  });

  it("documents the measured advisory Oxlint residual count without suppressions", () => {
    const releaseDoc = readText("docs/readme/release.md");
    expect(releaseDoc).toMatch(/Oxlint/u);
    expect(releaseDoc).toMatch(/\d+ errors \+ \d+ warnings/u);
    expect(manifest.scripts?.verify).not.toContain("lint:oxlint");
  });

  it("excludes the vendor and agent assets from the upstream sweep without hiding GUI tests", () => {
    const ignorePatterns = oxlintConfig.ignorePatterns ?? [];
    expect(ignorePatterns).toContain("tools/oxlint-anti-slop/**");
    for (const pattern of ignorePatterns) {
      expect(pattern).not.toMatch(/^(?:tests|\*\*)\/?\**$/u);
      expect(pattern).not.toContain("tests/");
    }
    // The strict sweep lists the GUI tests explicitly instead of ignoring them.
    expect(lintRunner).toContain('"gui."');
  });
});
