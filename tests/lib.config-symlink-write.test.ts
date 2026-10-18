import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeTextAtomic } from "../src/lib/atomic-json.js";
import { resolveEditableConfigPath } from "../src/lib/config-file-utils.js";
import {
  applyConfigDocumentEdit,
  planConfigDocumentEdit,
} from "../src/lib/opencode-config-editor.js";
import { applyScopedUpdatePlan, planScopedUpdate } from "../src/lib/scoped-update.js";

import { symlinkOrSkip } from "./helpers/symlink-capability.js";

// These tests pin the explicit spec override; without one, update uses the canonical release tag.
const EXPLICIT_UPDATE_SPEC = "file:./opencode-quota-gui-5.0.0.tgz";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-quota-config-symlink-write-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function editLinkedConfig(dir: string, desiredPlugin: string[]): Promise<string> {
  const plan = await planConfigDocumentEdit({
    target: resolveEditableConfigPath({
      dir,
      kind: "opencode",
      preferredFormat: "json",
    }),
    desiredData: { plugin: desiredPlugin },
  });
  await applyConfigDocumentEdit(plan);
  return plan.path;
}

describe("config symlink-preserving writes", () => {
  it("updates a relative symlink target and leaves the link in place", async (context) => {
    const root = makeTempDir();
    const real = join(root, "dotfiles", "opencode.json");
    const configDir = join(root, "config");
    mkdirSync(join(root, "dotfiles"), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(real, '{"plugin":[]}\n');
    if (!symlinkOrSkip(context, "../dotfiles/opencode.json", join(configDir, "opencode.json"))) {
      return;
    }

    await editLinkedConfig(configDir, ["a"]);

    expect(lstatSync(join(configDir, "opencode.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ plugin: ["a"] });
  });

  it("updates an absolute symlink and a chained pair", async (context) => {
    const root = makeTempDir();
    const real = join(root, "real.json");
    const middle = join(root, "middle.json");
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(real, '{"plugin":[]}\n');
    if (!symlinkOrSkip(context, real, middle)) return;
    if (!symlinkOrSkip(context, middle, join(configDir, "opencode.json"))) return;

    await editLinkedConfig(configDir, ["chained"]);

    expect(lstatSync(join(configDir, "opencode.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(middle).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ plugin: ["chained"] });
  });

  it("creates a missing regular config file", async () => {
    const dir = makeTempDir();
    const path = await editLinkedConfig(dir, ["new"]);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ plugin: ["new"] });
  });

  it("preserves JSONC comments when writing through a symlink", async (context) => {
    const root = makeTempDir();
    const real = join(root, "dotfiles", "opencode.jsonc");
    const configDir = join(root, "config");
    mkdirSync(join(root, "dotfiles"), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      real,
      `{
  // keep
  "plugin": ["other"],
}
`,
    );
    if (!symlinkOrSkip(context, real, join(configDir, "opencode.jsonc"))) return;

    const plan = await planConfigDocumentEdit({
      target: resolveEditableConfigPath({
        dir: configDir,
        kind: "opencode",
        preferredFormat: "jsonc",
        convertJsonToJsonc: true,
      }),
      desiredData: { plugin: ["other", "@slkiser/opencode-quota@latest"] },
    });
    await applyConfigDocumentEdit(plan);

    const updated = readFileSync(real, "utf8");
    expect(lstatSync(join(configDir, "opencode.jsonc")).isSymbolicLink()).toBe(true);
    expect(updated).toContain("// keep");
    expect(updated).toContain("@slkiser/opencode-quota@latest");
  });

  it("fails closed instead of deleting a symlinked JSON source during JSONC conversion", async (context) => {
    const root = makeTempDir();
    const real = join(root, "dotfiles", "opencode.json");
    const configDir = join(root, "config");
    mkdirSync(join(root, "dotfiles"), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(real, '{"plugin":[]}\n');
    if (!symlinkOrSkip(context, real, join(configDir, "opencode.json"))) return;

    await expect(
      planConfigDocumentEdit({
        target: resolveEditableConfigPath({
          dir: configDir,
          kind: "opencode",
          preferredFormat: "jsonc",
          convertJsonToJsonc: true,
        }),
        desiredData: { plugin: ["x"] },
      }),
    ).rejects.toThrow(/symlinked config source/);
    expect(lstatSync(join(configDir, "opencode.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(configDir, "opencode.jsonc"))).toBe(false);
    expect(readFileSync(real, "utf8")).toBe('{"plugin":[]}\n');
  });

  it("fails closed when the link is retargeted after preview", async (context) => {
    const root = makeTempDir();
    const real = join(root, "real.json");
    const other = join(root, "other.json");
    const configDir = join(root, "config");
    const link = join(configDir, "opencode.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(real, '{"plugin":[]}\n');
    writeFileSync(other, '{"plugin":[]}\n');
    if (!symlinkOrSkip(context, real, link)) return;

    const plan = await planConfigDocumentEdit({
      target: resolveEditableConfigPath({
        dir: configDir,
        kind: "opencode",
        preferredFormat: "json",
      }),
      desiredData: { plugin: ["a"] },
    });
    unlinkSync(link);
    if (!symlinkOrSkip(context, other, link)) return;

    await expect(applyConfigDocumentEdit(plan)).rejects.toThrow(/write target changed/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe('{"plugin":[]}\n');
    expect(readFileSync(other, "utf8")).toBe('{"plugin":[]}\n');
  });

  it("fails closed when destination bytes change after preview", async (context) => {
    const root = makeTempDir();
    const real = join(root, "real.json");
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(real, '{"plugin":[]}\n');
    if (!symlinkOrSkip(context, real, join(configDir, "opencode.json"))) return;

    const plan = await planConfigDocumentEdit({
      target: resolveEditableConfigPath({
        dir: configDir,
        kind: "opencode",
        preferredFormat: "json",
      }),
      desiredData: { plugin: ["a"] },
    });
    writeFileSync(real, '{"plugin":[],"raced":true}\n');

    await expect(applyConfigDocumentEdit(plan)).rejects.toThrow(/changed since preview/);
    expect(lstatSync(join(configDir, "opencode.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain('"raced":true');
  });

  it("fails closed on a dangling configured symlink instead of replacing it", async (context) => {
    const dir = makeTempDir();
    if (!symlinkOrSkip(context, join(dir, "missing.json"), join(dir, "opencode.json"))) return;
    await expect(editLinkedConfig(dir, ["x"])).rejects.toThrow(/Dangling config symlink/);
    expect(lstatSync(join(dir, "opencode.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, "missing.json"))).toBe(false);
  });

  it("leaves writeTextAtomic replacing a symlink for non-config callers", async (context) => {
    const dir = makeTempDir();
    const real = join(dir, "state.json");
    const link = join(dir, "alias.json");
    writeFileSync(real, "{}\n");
    if (!symlinkOrSkip(context, real, link)) return;
    await writeTextAtomic(link, '{"ok":true}\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(link, "utf8"))).toEqual({ ok: true });
    expect(readFileSync(real, "utf8")).toBe("{}\n");
  });
});

describe("scoped update symlink writes", () => {
  it("updates a linked package spec and deletes cache only after the write", async (context) => {
    const root = makeTempDir();
    const project = join(root, "project");
    const real = join(root, "dotfiles", "opencode.json");
    const cache = join(root, "cache", "opencode", "packages", "@slkiser", "opencode-quota@latest");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(root, "dotfiles"), { recursive: true });
    writeFileSync(
      real,
      '{"plugin":["@slkiser/opencode-quota@latest","@slkiser/opencode-quota@3.11.1"]}\n',
    );
    if (!symlinkOrSkip(context, real, join(project, "opencode.json"))) return;
    const manifest = join(cache, "node_modules", "@slkiser", "opencode-quota", "package.json");
    mkdirSync(join(manifest, ".."), { recursive: true });
    writeFileSync(manifest, '{"name":"@slkiser/opencode-quota"}\n');

    const env = {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_QUOTA_PLUGIN_SPEC: EXPLICIT_UPDATE_SPEC,
    } satisfies NodeJS.ProcessEnv;
    const plan = await planScopedUpdate({
      cwd: project,
      env,
      homeDir: join(root, "home"),
      platform: "linux",
    });
    expect(plan.configSnapshots[0]?.writeTarget.hops).toHaveLength(1);

    const result = await applyScopedUpdatePlan(plan);
    expect(result.writtenPaths).toEqual([join(project, "opencode.json")]);
    expect(lstatSync(join(project, "opencode.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain(EXPLICIT_UPDATE_SPEC);
    expect(result.removedCachePaths).toContain(cache);
    expect(existsSync(cache)).toBe(false);
  });

  it("does not delete cache when a linked config is retargeted after preview", async (context) => {
    const root = makeTempDir();
    const project = join(root, "project");
    const real = join(root, "dotfiles", "opencode.json");
    const other = join(root, "other.json");
    const cache = join(root, "cache", "opencode", "packages", "@slkiser", "opencode-quota@latest");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(root, "dotfiles"), { recursive: true });
    writeFileSync(real, '{"plugin":["@slkiser/opencode-quota@3.11.1"]}\n');
    writeFileSync(other, '{"plugin":["@slkiser/opencode-quota@3.11.1"]}\n');
    const link = join(project, "opencode.json");
    if (!symlinkOrSkip(context, real, link)) return;
    const manifest = join(cache, "node_modules", "@slkiser", "opencode-quota", "package.json");
    mkdirSync(join(manifest, ".."), { recursive: true });
    writeFileSync(manifest, '{"name":"@slkiser/opencode-quota"}\n');

    const env = {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_QUOTA_PLUGIN_SPEC: EXPLICIT_UPDATE_SPEC,
    } satisfies NodeJS.ProcessEnv;
    const plan = await planScopedUpdate({
      cwd: project,
      env,
      homeDir: join(root, "home"),
      platform: "linux",
    });
    unlinkSync(link);
    if (!symlinkOrSkip(context, other, link)) return;

    await expect(applyScopedUpdatePlan(plan)).rejects.toThrow(/write target changed/);
    expect(existsSync(manifest)).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("@3.11.1");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
