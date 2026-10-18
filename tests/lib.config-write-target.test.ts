import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertSameConfigWriteTarget,
  MAX_CONFIG_SYMLINK_HOPS,
  NEW_CONFIG_FILE_MODE,
  resolveConfigWriteTarget,
  writeConfiguredJsonAtomic,
  writeResolvedConfigText,
} from "../src/lib/config-write-target.js";

import { symlinkOrSkip } from "./helpers/symlink-capability.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-quota-config-write-target-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("resolveConfigWriteTarget", () => {
  it("treats a missing non-symlink path as a creatable regular file", async () => {
    const dir = makeTempDir();
    const path = join(dir, "nested", "opencode.json");
    await expect(resolveConfigWriteTarget(path)).resolves.toEqual({
      configuredPath: path,
      writePath: path,
      hops: [],
      terminalExisted: false,
    });
  });

  it("canonicalizes an existing regular file under a symlinked directory parent", async (context) => {
    const root = makeTempDir();
    const realParent = join(root, "actual");
    const aliasParent = join(root, "alias");
    const realFile = join(realParent, "opencode.json");
    mkdirSync(realParent);
    writeFileSync(realFile, "{}\n");
    if (!symlinkOrSkip(context, realParent, aliasParent, "dir")) return;
    const configured = join(aliasParent, "opencode.json");

    await expect(resolveConfigWriteTarget(configured)).resolves.toEqual({
      configuredPath: configured,
      writePath: realpathSync(realFile),
      hops: [],
      terminalExisted: true,
    });
  });

  it("resolves a relative hop from a symlinked directory parent using kernel semantics", async (context) => {
    const root = makeTempDir();
    const realParent = join(root, "actual", "place");
    const aliasParent = join(root, "elsewhere", "alias");
    const realFile = join(root, "actual", "secrets", "opencode.json");
    const wrongFile = join(root, "elsewhere", "secrets", "opencode.json");
    mkdirSync(realParent, { recursive: true });
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    mkdirSync(join(root, "actual", "secrets"), { recursive: true });
    mkdirSync(join(root, "elsewhere", "secrets"), { recursive: true });
    writeFileSync(realFile, '{"plugin":[]}\n');
    writeFileSync(wrongFile, '{"plugin":["wrong"]}\n');
    const linkedFile = join(realParent, "opencode.json");
    if (!symlinkOrSkip(context, "../secrets/opencode.json", linkedFile)) return;
    if (!symlinkOrSkip(context, realParent, aliasParent)) return;

    const configured = join(aliasParent, "opencode.json");
    // Windows stores backslashes even when symlinkSync receives forward slashes.
    const linkText = readlinkSync(configured);
    const target = await resolveConfigWriteTarget(configured);
    expect(target.writePath).toBe(realpathSync(realFile));
    expect(target.hops).toEqual([{ path: configured, linkText }]);
    expect(target.terminalExisted).toBe(true);

    await writeResolvedConfigText(target, '{"plugin":["ok"]}\n');
    expect(readFileSync(realFile, "utf8")).toBe('{"plugin":["ok"]}\n');
    expect(readFileSync(wrongFile, "utf8")).toBe('{"plugin":["wrong"]}\n');
    expect(lstatSync(configured).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configured)).toBe(linkText);
  });

  it("resolves a relative symlink to its regular-file target", async (context) => {
    const dir = makeTempDir();
    const real = join(dir, "dotfiles", "opencode.json");
    const link = join(dir, "config", "opencode.json");
    mkdirSync(join(dir, "dotfiles"), { recursive: true });
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(real, '{\n  "plugin": []\n}\n');
    if (!symlinkOrSkip(context, "../dotfiles/opencode.json", link)) return;
    const linkText = readlinkSync(link);

    await expect(resolveConfigWriteTarget(link)).resolves.toEqual({
      configuredPath: link,
      writePath: realpathSync(real),
      hops: [{ path: link, linkText }],
      terminalExisted: true,
    });
  });

  it("resolves an absolute symlink and a valid chain", async (context) => {
    const dir = makeTempDir();
    const real = join(dir, "real.json");
    const middle = join(dir, "middle.json");
    const link = join(dir, "link.json");
    writeFileSync(real, "{}\n");
    if (!symlinkOrSkip(context, real, middle)) return;
    if (!symlinkOrSkip(context, middle, link)) return;

    await expect(resolveConfigWriteTarget(link)).resolves.toEqual({
      configuredPath: link,
      writePath: realpathSync(real),
      hops: [
        { path: link, linkText: middle },
        { path: middle, linkText: real },
      ],
      terminalExisted: true,
    });
  });

  it("fails closed on a dangling symlink", async (context) => {
    const dir = makeTempDir();
    const missing = join(dir, "missing.json");
    const link = join(dir, "link.json");
    if (!symlinkOrSkip(context, missing, link)) return;
    await expect(resolveConfigWriteTarget(link)).rejects.toMatchObject({
      reason: "dangling",
      name: "ConfigWriteTargetError",
    });
  });

  it("fails closed on a symlink loop", async (context) => {
    const dir = makeTempDir();
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    if (!symlinkOrSkip(context, b, a)) return;
    if (!symlinkOrSkip(context, a, b)) return;
    await expect(resolveConfigWriteTarget(a)).rejects.toMatchObject({ reason: "loop" });
  });

  it("accepts a 40-hop chain and rejects a 41st hop", async (context) => {
    const dir = makeTempDir();
    const real = join(dir, "real.json");
    writeFileSync(real, "{}\n");
    let current = real;
    for (let index = 0; index < MAX_CONFIG_SYMLINK_HOPS; index += 1) {
      const next = join(dir, `link-${index}.json`);
      if (!symlinkOrSkip(context, current, next)) return;
      current = next;
    }
    await expect(resolveConfigWriteTarget(current)).resolves.toMatchObject({
      writePath: realpathSync(real),
      terminalExisted: true,
    });

    const extra = join(dir, "link-extra.json");
    if (!symlinkOrSkip(context, current, extra)) return;
    await expect(resolveConfigWriteTarget(extra)).rejects.toMatchObject({ reason: "depth" });
  });

  it("rejects a non-regular terminal target", async (context) => {
    const dir = makeTempDir();
    const targetDir = join(dir, "target-dir");
    const link = join(dir, "link.json");
    mkdirSync(targetDir);
    if (!symlinkOrSkip(context, targetDir, link)) return;
    await expect(resolveConfigWriteTarget(link)).rejects.toMatchObject({ reason: "non-regular" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a terminal it cannot inspect",
    async (context) => {
      const dir = makeTempDir();
      const hidden = join(dir, "hidden");
      const real = join(hidden, "opencode.json");
      const link = join(dir, "link.json");
      mkdirSync(hidden);
      writeFileSync(real, "{}\n");
      if (!symlinkOrSkip(context, real, link)) return;
      chmodSync(hidden, 0);
      try {
        await expect(resolveConfigWriteTarget(link)).rejects.toMatchObject({
          reason: "permission",
        });
      } finally {
        chmodSync(hidden, 0o700);
      }
    },
  );
});

describe("assertSameConfigWriteTarget", () => {
  it.each([
    ["../dotfiles/opencode.json", "..\\dotfiles\\opencode.json"],
    ["..\\dotfiles\\opencode.json", "../dotfiles/opencode.json"],
  ])("compares stored link text exactly: %s", (linkText, changedLinkText) => {
    const planned = {
      configuredPath: "config.json",
      writePath: "opencode.json",
      hops: [{ path: "config.json", linkText }],
      terminalExisted: true,
    };
    const current = { ...planned, hops: [{ ...planned.hops[0] }] };
    expect(() => assertSameConfigWriteTarget(planned, current)).not.toThrow();

    current.hops[0].linkText = changedLinkText;
    expect(() => assertSameConfigWriteTarget(planned, current)).toThrow(
      expect.objectContaining({ name: "ConfigWriteTargetError", reason: "changed" }),
    );
  });
});

describe("writeResolvedConfigText", () => {
  it("preserves an existing file mode and creates new files restrictively", async () => {
    const dir = makeTempDir();
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "{}\n");
    if (process.platform !== "win32") {
      chmodSync(existing, 0o640);
    }
    await writeResolvedConfigText(
      {
        configuredPath: existing,
        writePath: existing,
        hops: [],
        terminalExisted: true,
      },
      '{"ok":true}\n',
    );
    if (process.platform !== "win32") {
      expect(lstatSync(existing).mode & 0o777).toBe(0o640);
    }

    const created = join(dir, "created.json");
    await writeResolvedConfigText(
      {
        configuredPath: created,
        writePath: created,
        hops: [],
        terminalExisted: false,
      },
      '{"ok":true}\n',
    );
    if (process.platform !== "win32") {
      expect(lstatSync(created).mode & 0o777).toBe(NEW_CONFIG_FILE_MODE);
    }
  });

  it("does not delete the destination when rename fails", async () => {
    const dir = makeTempDir();
    const dest = join(dir, "opencode.json");
    mkdirSync(dest);
    writeFileSync(join(dest, "keep.txt"), "safe\n");

    await expect(
      writeResolvedConfigText(
        {
          configuredPath: dest,
          writePath: dest,
          hops: [],
          terminalExisted: false,
        },
        '{"ok":true}\n',
      ),
    ).rejects.toThrow();

    expect(lstatSync(dest).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, "keep.txt"), "utf8")).toBe("safe\n");
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(existsSync(dest)).toBe(true);
  });
});

describe("writeConfiguredJsonAtomic", () => {
  it("writes through a symlink without replacing the link", async (context) => {
    const dir = makeTempDir();
    const real = join(dir, "dotfiles", "opencode.json");
    const link = join(dir, "opencode.json");
    mkdirSync(join(dir, "dotfiles"), { recursive: true });
    writeFileSync(real, '{"plugin":[]}\n');
    if (!symlinkOrSkip(context, real, link)) return;

    await writeConfiguredJsonAtomic(link, { plugin: ["a"] }, { trailingNewline: true });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ plugin: ["a"] });
  });
});
