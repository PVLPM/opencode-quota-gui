import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isVerifiedQuotaPluginSpec } from "../src/lib/config-file-utils.js";
import {
  applyInitInstallerPlan,
  type InitInstallerSelections,
  isVerifiedGuiQuotaPluginSpec,
  planInitInstaller,
} from "../src/lib/init-installer.js";
import { parseJsonOrJsonc } from "../src/lib/jsonc.js";

vi.mock("../src/lib/opencode-version.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/opencode-version.js")>();
  return {
    ...original,
    detectOpenCodeMajor: () => original.detectOpenCodeMajor(async () => "opencode v2.1.2"),
  };
});
const dirs: string[] = [];
let savedConfigDir: string | undefined;
beforeEach(() => {
  savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const globalConfigDir = mkdtempSync(join(tmpdir(), "quota-v2-global-"));
  dirs.push(globalConfigDir);
  process.env.OPENCODE_CONFIG_DIR = globalConfigDir;
});
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const selections: InitInstallerSelections = {
  interfaces: "web",
  scope: "project",
  quotaUi: ["none"],
  providerMode: "auto",
  manualProviders: [],
  formatStyle: "allWindows",
  percentDisplayMode: "remaining",
  showSessionTokens: false,
};
const desired = "file:./opencode-quota-gui-6.0.0.tgz";
function fixture(data?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "quota-v2-"));
  dirs.push(dir);
  if (data) writeFileSync(join(dir, "opencode.jsonc"), `${JSON.stringify(data)}\n`);
  return dir;
}
function host(dir: string) {
  return parseJsonOrJsonc(readFileSync(join(dir, "opencode.jsonc"), "utf8"), true) as Record<
    string,
    unknown
  >;
}
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function syntheticPackageTarball(name: string): Buffer {
  const manifest = Buffer.from(JSON.stringify({ name, version: "1.2.3" }));
  const header = Buffer.alloc(512);
  header.write("package/package.json");
  header.write("0000644\0", 100);
  header.write(`${manifest.length.toString(8).padStart(11, "0")}\0`, 124);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(
    Buffer.concat([header, manifest, Buffer.alloc(512 - manifest.length), Buffer.alloc(1024)]),
  );
}
describe("current v2 installer desired plugin safety", () => {
  it.each([
    "./checkout/server.ts",
    "file:./checkout/server.ts",
  ])("replaces verified root entry %s, preserving options, unrelated entries and preview bytes", async (old) => {
    const unrelated = [
      "./wrong/server.ts",
      "./missing/server.ts",
      "./checkout/other.ts",
      "file:./opencode-quota-gui-unknown.tgz",
    ];
    const dir = fixture({
      plugins: ["before", { package: old, options: { keep: true } }, ...unrelated, "after"],
    });
    for (const [folder, name] of [
      ["checkout", "opencode-quota-gui"],
      ["wrong", "other-plugin"],
    ] as const) {
      mkdirSync(join(dir, folder), { recursive: true });
      writeFileSync(join(dir, folder, "package.json"), JSON.stringify({ name }));
      writeFileSync(join(dir, folder, "server.ts"), "export {};");
    }
    mkdirSync(join(dir, "missing"));
    writeFileSync(join(dir, "missing", "server.ts"), "export {};");
    writeFileSync(join(dir, "checkout", "other.ts"), "export {};");
    const before = readFileSync(join(dir, "opencode.jsonc"), "utf8");
    const plan = await planInitInstaller({ cwd: dir, selections, pluginSpec: desired });
    expect(readFileSync(join(dir, "opencode.jsonc"), "utf8")).toBe(before);
    expect(plan.summaryLines.join("\n")).toContain(
      `${JSON.stringify(old)} -> ${JSON.stringify(desired)}`,
    );
    await applyInitInstallerPlan(plan);
    expect(host(dir).plugins).toEqual([
      "before",
      { package: desired, options: { keep: true } },
      ...unrelated,
      "after",
    ]);
    const second = await planInitInstaller({ cwd: dir, selections, pluginSpec: desired });
    expect(second.edits[0]?.changed).toBe(false);
  });
  it.each([
    "nonexistent",
    "wrong-manifest",
  ])("preserves an unverified %s archive despite a matching package filename", async (kind) => {
    const old = "file:./opencode-quota-gui-1.2.3.tgz";
    const dir = fixture({ plugins: ["before", old, desired, "after"] });
    if (kind === "wrong-manifest")
      writeFileSync(
        join(dir, "opencode-quota-gui-1.2.3.tgz"),
        syntheticPackageTarball("unrelated-plugin"),
      );
    expect(await isVerifiedQuotaPluginSpec(old, dir)).toBe(false);
    const plan = await planInitInstaller({ cwd: dir, selections, pluginSpec: desired });
    expect(plan.edits[0]?.changed).toBe(false);
    await applyInitInstallerPlan(plan);
    expect(host(dir).plugins).toEqual(["before", old, desired, "after"]);
  });
  it("accepts only GUI-owned root server and dist/index entry shapes", async () => {
    const dir = fixture();
    write(join(dir, "checkout", "package.json"), '{"name":"opencode-quota-gui"}');
    for (const file of ["server.ts", "nested/other.ts", "dist/index.js", "dist/other.js"]) {
      write(join(dir, "checkout", file), "export {};");
    }

    expect(await isVerifiedGuiQuotaPluginSpec("./checkout/server.ts", dir)).toBe(true);
    expect(await isVerifiedGuiQuotaPluginSpec("file:./checkout/server.ts", dir)).toBe(true);
    expect(await isVerifiedGuiQuotaPluginSpec("./checkout/dist/index.js", dir)).toBe(true);
    expect(await isVerifiedGuiQuotaPluginSpec("./checkout/nested/other.ts", dir)).toBe(false);
    expect(await isVerifiedGuiQuotaPluginSpec("./checkout/dist/other.js", dir)).toBe(false);
    expect(await isVerifiedGuiQuotaPluginSpec("./checkout/other.ts", dir)).toBe(false);
  });
  it("does not verify upstream or foreign manifests as GUI roots", async () => {
    const dir = fixture();
    write(join(dir, "upstream", "package.json"), '{"name":"@slkiser/opencode-quota"}');
    write(join(dir, "upstream", "server.ts"), "export {};");
    write(join(dir, "foreign", "package.json"), '{"name":"other-plugin"}');
    write(join(dir, "foreign", "server.ts"), "export {};");

    expect(await isVerifiedGuiQuotaPluginSpec("./upstream/server.ts", dir)).toBe(false);
    expect(await isVerifiedGuiQuotaPluginSpec("./foreign/server.ts", dir)).toBe(false);
    expect(await isVerifiedGuiQuotaPluginSpec("@slkiser/opencode-quota@latest", dir)).toBe(false);
  });
  it("writes plural plugins for detected 2.1.2", async () => {
    const dir = fixture();
    await applyInitInstallerPlan(
      await planInitInstaller({ cwd: dir, selections, pluginSpec: desired }),
    );
    expect(host(dir).plugins).toEqual([desired]);
    expect(host(dir).plugin).toBeUndefined();
  });
  it("does not rewrite a matching config merely to add a trailing newline", async () => {
    const dir = fixture();
    const raw = JSON.stringify({ plugins: [desired] });
    writeFileSync(join(dir, "opencode.jsonc"), raw);
    const plan = await planInitInstaller({ cwd: dir, selections, pluginSpec: desired });
    expect(plan.edits[0]?.changed).toBe(false);
    await applyInitInstallerPlan(plan);
    expect(readFileSync(join(dir, "opencode.jsonc"), "utf8")).toBe(raw);
  });
  it("preserves unverified versioned tarballs instead of inferring their identity from a filename", async () => {
    const dir = fixture({
      plugins: ["before", "file:./opencode-quota-gui-5.0.0.tgz", desired, "after"],
    });
    const plan = await planInitInstaller({ cwd: dir, selections, pluginSpec: desired });
    await applyInitInstallerPlan(plan);
    expect(host(dir).plugins).toEqual([
      "before",
      "file:./opencode-quota-gui-5.0.0.tgz",
      desired,
      "after",
    ]);
  });
  it("previews duplicate removal with the exact removed and retained specs", async () => {
    const old = "opencode-quota-gui@latest";
    const dir = fixture({ plugins: [desired, old] });
    const plan = await planInitInstaller({ cwd: dir, selections, pluginSpec: desired });
    expect(plan.summaryLines.join("\n")).toContain(
      `remove duplicate quota plugin ${JSON.stringify(old)}; keep ${JSON.stringify(desired)}`,
    );
    await applyInitInstallerPlan(plan);
    expect(host(dir).plugins).toEqual([desired]);
  });
  it("refuses ambiguous duplicate options instead of discarding them", async () => {
    const dir = fixture({
      plugins: [
        { package: "opencode-quota-gui@latest", options: { one: true } },
        { package: desired, options: { two: true } },
      ],
    });
    await expect(planInitInstaller({ cwd: dir, selections, pluginSpec: desired })).rejects.toThrow(
      "different options",
    );
    expect(host(dir).plugins).toEqual([
      { package: "opencode-quota-gui@latest", options: { one: true } },
      { package: desired, options: { two: true } },
    ]);
  });
  it("preserves unrelated array member comments and formatting during replacement", async () => {
    const dir = fixture();
    const sibling = '{ "package": "other", "options": { "keep": true } }';
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{\n "plugins": [\n  // first plugin\n  "before",\n  "opencode-quota-gui@latest",\n  // preserve sibling\n  ${sibling},\n ],\n}\n`,
    );
    await applyInitInstallerPlan(
      await planInitInstaller({ cwd: dir, selections, pluginSpec: desired }),
    );
    const raw = readFileSync(join(dir, "opencode.jsonc"), "utf8");
    expect(raw).toContain(`// preserve sibling\n  ${sibling},`);
    expect(raw).toContain('// first plugin\n  "before",');
  });
  it("replaces opencode-quota-gui@latest in place with the exact desired spec and previews both", async () => {
    const old = "opencode-quota-gui@latest";
    const other = { package: "other-plugin", options: { keep: true } };
    const dir = fixture({
      plugins: ["before", { package: old, options: { keep: true } }, other, "after"],
    });
    const plan = await planInitInstaller({ cwd: dir, selections, pluginSpec: desired });
    expect(plan.summaryLines.join("\n")).toContain(old);
    expect(plan.summaryLines.join("\n")).toContain(desired);
    await applyInitInstallerPlan(plan);
    expect(host(dir).plugins).toEqual([
      "before",
      { package: desired, options: { keep: true } },
      other,
      "after",
    ]);
    expect(host(dir).plugin).toBeUndefined();
  });
  it("preserves an upstream entry and appends the desired GUI entry", async () => {
    const old = "@slkiser/opencode-quota@latest";
    const other = { package: "other-plugin", options: { keep: true } };
    const dir = fixture({
      plugins: ["before", { package: old, options: { keep: true } }, other, "after"],
    });
    const plan = await planInitInstaller({ cwd: dir, selections, pluginSpec: desired });
    expect(plan.summaryLines.join("\n")).not.toContain(old);
    expect(plan.summaryLines.join("\n")).toContain(desired);
    await applyInitInstallerPlan(plan);
    expect(host(dir).plugins).toEqual([
      "before",
      { package: old, options: { keep: true } },
      other,
      "after",
      desired,
    ]);
    expect(host(dir).plugin).toBeUndefined();
  });
  it("identifies relative dist entries by local package metadata, not a quota substring", async () => {
    const dir = fixture({
      plugins: [
        "./checkout/dist/index.js",
        "./some-quota-helper/dist/index.js",
        "some-quota-helper",
        "file:./opencode-quota-gui-unknown.tgz",
      ],
    });
    mkdirSync(join(dir, "checkout"), { recursive: true });
    writeFileSync(join(dir, "checkout", "package.json"), '{"name":"opencode-quota-gui"}');
    const plan = await planInitInstaller({ cwd: dir, selections, pluginSpec: desired });
    await applyInitInstallerPlan(plan);
    expect(host(dir).plugins).toEqual([
      desired,
      "./some-quota-helper/dist/index.js",
      "some-quota-helper",
      "file:./opencode-quota-gui-unknown.tgz",
    ]);
  });
  it("preserves an upstream singular entry while adding the desired GUI entry", async () => {
    const dir = fixture({
      plugin: ["before", ["@slkiser/opencode-quota@latest", { keep: true }], "after"],
      plugins: ["native"],
    });
    await applyInitInstallerPlan(
      await planInitInstaller({ cwd: dir, selections, pluginSpec: desired }),
    );
    expect(host(dir)).toEqual({
      plugin: ["before", ["@slkiser/opencode-quota@latest", { keep: true }], "after"],
      plugins: ["native", desired],
    });
  });
  it("is byte-idempotent when the exact desired spec is already present", async () => {
    const dir = fixture({ plugins: ["other", desired] });
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{\n  // retain custom plugin comments\n  "plugins": ["other", "${desired}"],\n}\n`,
    );
    const before = readFileSync(join(dir, "opencode.jsonc"), "utf8");
    const plan = await planInitInstaller({ cwd: dir, selections, pluginSpec: desired });
    expect(plan.edits[0]?.changed).toBe(false);
    await applyInitInstallerPlan(plan);
    expect(readFileSync(join(dir, "opencode.jsonc"), "utf8")).toBe(before);
  });
  it.each(["plugin", "plugins"])("refuses malformed %s containers before writing", async (key) => {
    const dir = fixture({ [key]: { invalid: true } });
    await expect(planInitInstaller({ cwd: dir, selections, pluginSpec: desired })).rejects.toThrow(
      `${key} is not an array`,
    );
  });
});
