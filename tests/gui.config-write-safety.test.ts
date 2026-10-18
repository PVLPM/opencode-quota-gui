import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGuiSettingsStore, GuiSettingsError } from "../src/gui/config.js";
import { parseJsonOrJsonc } from "../src/lib/jsonc.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
  writeQuotaSidecarConfig,
} from "./helpers/config-loader-test-harness.js";

const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("opencode-quota-gui-write-");
  workspaces.push(workspace);
  return workspace;
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    workspace.cleanup();
  }
});

/**
 * Real-file-system symlink coverage is capability-gated: when this host cannot
 * create symlinks the concrete cases report an honest skip (never a pass) and
 * must be re-run on linux/macOS (POSIX) or Windows with Developer Mode enabled.
 */
const symlinkProbe = (() => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-quota-gui-symlink-probe-"));
  try {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "x", "utf8");
    symlinkSync(target, link, "file");
    return { ok: true, reason: "" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const symlinkIt = it.runIf(symlinkProbe.ok);

if (!symlinkProbe.ok) {
  console.warn(
    `[gui.config-write-safety] symlink cases SKIPPED: this host cannot create symlinks ` +
      `(${symlinkProbe.reason}). Required re-run environment: linux/macOS (POSIX) or Windows ` +
      `with Developer Mode enabled. Skipped cases: dangling link, symlink loop, >40-hop chain, ` +
      `symlink write-through.`,
  );
}

function makeStore(workspace: GuiConfigWorkspace) {
  return createGuiSettingsStore({
    configDir: workspace.configDir,
    workspaceRoot: workspace.workspaceRoot,
  });
}

async function expectGuiError(
  run: Promise<unknown>,
  code: string,
  details?: Record<string, unknown>,
): Promise<GuiSettingsError> {
  const error = await run.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(GuiSettingsError);
  const guiError = error as GuiSettingsError;
  expect(guiError.code).toBe(code);
  if (details) {
    expect(guiError.details).toMatchObject(details);
  }
  return guiError;
}

describe("canonical config write safety", () => {
  it("creates the file and directory on first write with owner-only modes", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    await store.saveSettings({
      patch: { minIntervalMs: 1000 },
      expectedRevision: before.revision,
    });

    expect(lstatSync(workspace.guiConfigPath).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(workspace.guiConfigPath, "utf8"))).toEqual({
      minIntervalMs: 1000,
    });

    if (process.platform !== "win32") {
      expect(statSync(workspace.guiConfigDir).mode & 0o777).toBe(0o700);
      expect(lstatSync(workspace.guiConfigPath).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves comments and unrelated keys when editing", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(
      workspace,
      `{
  // user comment
  "minIntervalMs": 1000,
  "somethingElse": { "kept": true },
}
`,
    );
    const store = makeStore(workspace);
    const before = await store.settings();

    await store.saveSettings({
      patch: { minIntervalMs: 2000 },
      expectedRevision: before.revision,
    });

    const raw = readFileSync(workspace.guiConfigPath, "utf8");
    expect(raw).toContain("// user comment");
    expect(raw).toContain('"somethingElse"');
    expect((parseJsonOrJsonc(raw, true) as { minIntervalMs: number }).minIntervalMs).toBe(2000);
  });

  it("does not rewrite the file when the written value is identical", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(
      workspace,
      `{
  "minIntervalMs": 1000,
  "trailingMarker": true,
}
`,
    );
    const store = makeStore(workspace);
    const before = await store.settings();

    const result = await store.saveSettings({
      patch: { minIntervalMs: 1000 },
      expectedRevision: before.revision,
    });

    expect(result.applied).toEqual({ minIntervalMs: 1000 });
    expect(result.revision).toBe(before.revision);
    expect(readFileSync(workspace.guiConfigPath, "utf8")).toContain('"trailingMarker": true');
  });

  it("refuses writes on a malformed file and never overwrites it", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, { accountingDetail: "detailed" });
    writeGuiCanonicalConfig(workspace, "{ broken");
    const store = makeStore(workspace);

    const snapshot = await store.settings();
    expect(snapshot.values.accountingDetail).toBe("detailed");
    expect(snapshot.issues.some((issue) => issue.key === "$root")).toBe(true);

    const error = await expectGuiError(
      store.saveSettings({ patch: { minIntervalMs: 1000 }, expectedRevision: snapshot.revision }),
      "config-read-error",
    );
    expect(error.message).not.toContain(workspace.tempDir);
    expect(error.message).not.toContain(workspace.configDir);
    expect(readFileSync(workspace.guiConfigPath, "utf8")).toBe("{ broken");
  });

  it("rejects a stale revision with config-changed and leaves the file alone", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();
    await store.saveSettings({
      patch: { minIntervalMs: 1000 },
      expectedRevision: before.revision,
    });
    const bytes = readFileSync(workspace.guiConfigPath, "utf8");

    const error = await expectGuiError(
      store.saveSettings({ patch: { minIntervalMs: 2000 }, expectedRevision: before.revision }),
      "config-changed",
    );
    expect(error.message).not.toContain(workspace.tempDir);
    expect(readFileSync(workspace.guiConfigPath, "utf8")).toBe(bytes);
  });

  it("serializes concurrent writers so only one wins", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    const [first, second] = await Promise.allSettled([
      store.saveSettings({ patch: { minIntervalMs: 1000 }, expectedRevision: before.revision }),
      store.saveSettings({ patch: { requestTimeoutMs: 2500 }, expectedRevision: before.revision }),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    const rejection = second.status === "rejected" ? second.reason : null;
    expect(rejection).toBeInstanceOf(GuiSettingsError);
    expect((rejection as GuiSettingsError).code).toBe("config-changed");

    expect(JSON.parse(readFileSync(workspace.guiConfigPath, "utf8"))).toEqual({
      minIntervalMs: 1000,
    });
  });

  it("maps a non-regular write target to config-target-error", async () => {
    const workspace = makeWorkspace();
    mkdirSync(workspace.guiConfigPath, { recursive: true });
    const store = makeStore(workspace);
    const before = await store.settings();

    const error = await expectGuiError(
      store.saveSettings({ patch: { minIntervalMs: 1000 }, expectedRevision: before.revision }),
      "config-target-error",
      { reason: "non-regular" },
    );
    expect(error.message).not.toContain(workspace.tempDir);
    expect(lstatSync(workspace.guiConfigPath).isDirectory()).toBe(true);
  });

  symlinkIt("writes through a symlinked canonical file and keeps the link", async () => {
    const workspace = makeWorkspace();
    const real = join(workspace.tempDir, "dotfiles", "config.jsonc");
    mkdirSync(join(workspace.tempDir, "dotfiles"), { recursive: true });
    writeFileSync(real, '{\n  "minIntervalMs": 1000\n}\n', "utf8");
    mkdirSync(workspace.guiConfigDir, { recursive: true });
    symlinkSync(real, workspace.guiConfigPath, "file");

    const store = makeStore(workspace);
    const before = await store.settings();
    await store.saveSettings({
      patch: { minIntervalMs: 2000 },
      expectedRevision: before.revision,
    });

    expect(lstatSync(workspace.guiConfigPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ minIntervalMs: 2000 });
  });

  symlinkIt("fails closed on a dangling symlink instead of creating the target", async () => {
    const workspace = makeWorkspace();
    mkdirSync(workspace.guiConfigDir, { recursive: true });
    const missing = join(workspace.guiConfigDir, "missing.jsonc");
    symlinkSync(missing, workspace.guiConfigPath, "file");
    const store = makeStore(workspace);
    const before = await store.settings();

    await expectGuiError(
      store.saveSettings({ patch: { minIntervalMs: 1000 }, expectedRevision: before.revision }),
      "config-target-error",
      { reason: "dangling" },
    );
    expect(existsSync(missing)).toBe(false);
    expect(lstatSync(workspace.guiConfigPath).isSymbolicLink()).toBe(true);
  });

  symlinkIt("fails closed on a symlink loop", async () => {
    const workspace = makeWorkspace();
    mkdirSync(workspace.guiConfigDir, { recursive: true });
    const first = join(workspace.guiConfigDir, "first.jsonc");
    const second = join(workspace.guiConfigDir, "second.jsonc");
    symlinkSync(second, first, "file");
    symlinkSync(first, second, "file");
    symlinkSync(first, workspace.guiConfigPath, "file");
    const store = makeStore(workspace);
    const before = await store.settings();

    await expectGuiError(
      store.saveSettings({ patch: { minIntervalMs: 1000 }, expectedRevision: before.revision }),
      "config-target-error",
      { reason: "loop" },
    );
  });

  symlinkIt("fails closed on a symlink chain longer than 40 hops", async () => {
    const workspace = makeWorkspace();
    const real = join(workspace.guiConfigDir, "real.jsonc");
    mkdirSync(workspace.guiConfigDir, { recursive: true });
    writeFileSync(real, "{}\n", "utf8");
    let previous = real;
    for (let index = 0; index < 42; index += 1) {
      const link = join(workspace.guiConfigDir, `hop-${index}.jsonc`);
      symlinkSync(previous, link, "file");
      previous = link;
    }
    symlinkSync(previous, workspace.guiConfigPath, "file");
    const store = makeStore(workspace);
    const before = await store.settings();

    await expectGuiError(
      store.saveSettings({ patch: { minIntervalMs: 1000 }, expectedRevision: before.revision }),
      "config-target-error",
      { reason: "depth" },
    );
    expect(readFileSync(real, "utf8")).toBe("{}\n");
  });
});
