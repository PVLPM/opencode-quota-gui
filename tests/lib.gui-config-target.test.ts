import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertGuiConfigTargetIsIndependent } from "../src/lib/gui-config-target.js";
import { symlinkOrSkip } from "./helpers/symlink-capability.js";

const dirs: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-quota-gui-target-"));
  dirs.push(dir);
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function upstreamSentinel(configDir: string): { root: string; file: string } {
  const root = join(configDir, "opencode-quota");
  const file = join(root, "quota-toast.jsonc");
  write(file, '{"sentinel":"upstream"}\n');
  return { root, file };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GUI canonical config target independence", () => {
  it("accepts a normal GUI target beside upstream", async () => {
    const configDir = fixture();
    const upstream = upstreamSentinel(configDir);
    const target = join(configDir, "opencode-quota-gui", "config.jsonc");

    await expect(assertGuiConfigTargetIsIndependent(target, configDir)).resolves.toBeUndefined();
    expect(readFileSync(upstream.file, "utf8")).toBe('{"sentinel":"upstream"}\n');
  });

  it("rejects the upstream quota-toast path before planning", async () => {
    const configDir = fixture();
    const upstream = upstreamSentinel(configDir);

    await expect(assertGuiConfigTargetIsIndependent(upstream.file, configDir)).rejects.toThrow(
      /upstream quota configuration/i,
    );
    expect(readFileSync(upstream.file, "utf8")).toBe('{"sentinel":"upstream"}\n');
  });

  it("rejects a GUI directory that aliases the upstream root", async (context) => {
    const configDir = fixture();
    const upstream = upstreamSentinel(configDir);
    const guiDir = join(configDir, "opencode-quota-gui");
    if (
      !symlinkOrSkip(
        context,
        upstream.root,
        guiDir,
        process.platform === "win32" ? "junction" : "dir",
      )
    ) {
      return;
    }
    const target = join(guiDir, "config.jsonc");

    await expect(assertGuiConfigTargetIsIndependent(target, configDir)).rejects.toThrow(
      /upstream quota configuration/i,
    );
    expect(readFileSync(upstream.file, "utf8")).toBe('{"sentinel":"upstream"}\n');
  });

  it("rejects a GUI file symlink that resolves to upstream quota-toast", async (context) => {
    const configDir = fixture();
    const upstream = upstreamSentinel(configDir);
    const guiDir = join(configDir, "opencode-quota-gui");
    mkdirSync(guiDir, { recursive: true });
    const target = join(guiDir, "config.jsonc");
    if (!symlinkOrSkip(context, upstream.file, target, "file")) return;

    await expect(assertGuiConfigTargetIsIndependent(target, configDir)).rejects.toThrow(
      /upstream quota configuration/i,
    );
    expect(readFileSync(upstream.file, "utf8")).toBe('{"sentinel":"upstream"}\n');
  });

  it("rejects an upstream file alias that resolves to the GUI target", async (context) => {
    const configDir = fixture();
    const guiDir = join(configDir, "opencode-quota-gui");
    const target = join(guiDir, "config.jsonc");
    write(target, '{"gui":true}\n');
    const upstreamRoot = join(configDir, "opencode-quota");
    mkdirSync(upstreamRoot, { recursive: true });
    const upstreamFile = join(upstreamRoot, "quota-toast.jsonc");
    if (!symlinkOrSkip(context, target, upstreamFile, "file")) return;

    await expect(assertGuiConfigTargetIsIndependent(target, configDir)).rejects.toThrow(
      /upstream quota configuration/i,
    );
    expect(readFileSync(target, "utf8")).toBe('{"gui":true}\n');
  });

  it("allows a legitimate GUI file symlink outside upstream", async (context) => {
    const configDir = fixture();
    upstreamSentinel(configDir);
    const guiDir = join(configDir, "opencode-quota-gui");
    const realTarget = join(configDir, "legitimate", "config.jsonc");
    const target = join(guiDir, "config.jsonc");
    write(realTarget, '{"gui":true}\n');
    mkdirSync(guiDir, { recursive: true });
    if (!symlinkOrSkip(context, realTarget, target, "file")) return;

    await expect(assertGuiConfigTargetIsIndependent(target, configDir)).resolves.toBeUndefined();
    expect(readFileSync(realTarget, "utf8")).toBe('{"gui":true}\n');
  });
});
