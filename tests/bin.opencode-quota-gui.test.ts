import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { symlinkOrSkip } from "./helpers/symlink-capability.js";

const commandMocks = vi.hoisted(() => ({
  runInitInstaller: vi.fn(),
  runCliShowCommand: vi.fn(),
  runCliStatusCommand: vi.fn(),
  runScopedUpdateCommand: vi.fn(),
  getPackageVersion: vi.fn(),
}));

vi.mock("../src/lib/init-installer.js", () => ({
  runInitInstaller: commandMocks.runInitInstaller,
}));

vi.mock("../src/lib/cli-show.js", () => ({
  runCliShowCommand: commandMocks.runCliShowCommand,
}));

vi.mock("../src/lib/cli-status.js", () => ({
  runCliStatusCommand: commandMocks.runCliStatusCommand,
}));

vi.mock("../src/lib/scoped-update.js", () => ({
  runScopedUpdateCommand: commandMocks.runScopedUpdateCommand,
}));

vi.mock("../src/lib/version.js", () => ({
  getPackageVersion: commandMocks.getPackageVersion,
}));

describe("opencode-quota-gui bin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandMocks.runInitInstaller.mockResolvedValue(0);
    commandMocks.runCliShowCommand.mockResolvedValue(0);
    commandMocks.runCliStatusCommand.mockResolvedValue(0);
    commandMocks.runScopedUpdateCommand.mockResolvedValue(0);
    commandMocks.getPackageVersion.mockResolvedValue("9.8.7");
  });

  it("dispatches init to the interactive installer", async () => {
    const { main } = await import("../src/bin/opencode-quota-gui.js");

    const code = await main(["init"]);

    expect(code).toBe(0);
    expect(commandMocks.runInitInstaller).toHaveBeenCalledWith({});
    expect(commandMocks.runCliShowCommand).not.toHaveBeenCalled();
  });

  it("passes only init dry-run to the installer and never syncs upstream legacy config", async () => {
    const { main } = await import("../src/bin/opencode-quota-gui.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await main(["init", "--dry-run"])).toBe(0);
    expect(commandMocks.runInitInstaller).toHaveBeenCalledWith({ dryRun: true });

    commandMocks.runInitInstaller.mockClear();
    expect(await main(["init", "--sync-legacy-config"])).toBe(1);
    expect(commandMocks.runInitInstaller).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    log.mockRestore();
  });

  it("rejects removed show, status, and provider-add commands without dispatch or prompts", async () => {
    const { main } = await import("../src/bin/opencode-quota-gui.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    for (const argv of [
      ["show"],
      ["show", "--json", "--provider", "copilot"],
      ["status"],
      ["status", "--provider", "copilot", "--json"],
      ["provider", "add", "--dry-run"],
    ]) {
      expect(await main(argv)).toBe(1);
    }

    expect(commandMocks.runCliShowCommand).not.toHaveBeenCalled();
    expect(commandMocks.runCliStatusCommand).not.toHaveBeenCalled();
    expect(commandMocks.runInitInstaller).not.toHaveBeenCalled();
    expect(commandMocks.runScopedUpdateCommand).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    log.mockRestore();
  });

  it("dispatches update args to the scoped maintenance updater", async () => {
    const { main } = await import("../src/bin/opencode-quota-gui.js");

    const code = await main(["update", "--dry-run", "--yes"]);

    expect(code).toBe(0);
    expect(commandMocks.runScopedUpdateCommand).toHaveBeenCalledWith({
      argv: ["--dry-run", "--yes"],
    });
  });

  it("prints GUI-only help and exits zero for --help", async () => {
    const { main } = await import("../src/bin/opencode-quota-gui.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["--help"]);

    expect(code).toBe(0);
    const help = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(help).toContain("Usage:");
    expect(help).toContain("opencode-quota-gui init");
    expect(help).toContain("opencode-quota-gui update");
    expect(help).toContain("opencode-quota-gui --help");
    expect(help).toContain("opencode-quota-gui --version");
    expect(help).not.toContain("opencode-quota-gui show");
    expect(help).not.toContain("opencode-quota-gui status");
    expect(help).not.toContain("provider add");
    expect(help).not.toContain("sync-legacy-config");
    expect(help).toContain("Credential-specific audit sources and values are not read");
    expect(help).toContain(
      "Values encountered in normal config parsing are never printed, copied, or modified",
    );
    log.mockRestore();
  });

  it("prints the package version for --version and version", async () => {
    const { main } = await import("../src/bin/opencode-quota-gui.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await main(["--version"])).toBe(0);
    expect(await main(["version"])).toBe(0);
    expect(log.mock.calls).toEqual([["9.8.7"], ["9.8.7"]]);
    log.mockRestore();
  });

  it("prints usage and exits non-zero for no args", async () => {
    const { main } = await import("../src/bin/opencode-quota-gui.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main([]);

    expect(code).toBe(1);
    const usage = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(usage).toContain("Usage:");
    expect(usage).toContain("opencode-quota-gui update");
    expect(usage).not.toContain("opencode-quota-gui show");
    expect(usage).not.toContain("opencode-quota-gui status");
    log.mockRestore();
  });

  it("prints usage and exits non-zero for unknown commands", async () => {
    const { main } = await import("../src/bin/opencode-quota-gui.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["wat"]);

    expect(code).toBe(1);
    const usage = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(usage).toContain("Usage:");
    expect(usage).not.toContain("opencode-quota-gui show");
    log.mockRestore();
  });

  it("classifies non-symlinked bin paths as non-direct execution", async () => {
    const { cliShouldRunMain } = await import("../src/bin/opencode-quota-gui.js");

    const modulePath = fileURLToPath(new URL("../src/bin/opencode-quota-gui.ts", import.meta.url));
    const tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-gui-bin-"));

    try {
      expect(cliShouldRunMain(join(tempDir, "other.js"), modulePath)).toBe(false);
      expect(cliShouldRunMain(undefined, modulePath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats symlinked bin paths as direct CLI execution", async (context) => {
    const { cliShouldRunMain } = await import("../src/bin/opencode-quota-gui.js");

    const modulePath = fileURLToPath(new URL("../src/bin/opencode-quota-gui.ts", import.meta.url));
    const tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-gui-bin-"));
    const symlinkPath = join(tempDir, "opencode-quota-gui");

    try {
      if (!symlinkOrSkip(context, modulePath, symlinkPath)) return;

      expect(cliShouldRunMain(symlinkPath, modulePath)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
