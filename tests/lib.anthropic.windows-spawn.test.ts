import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// These checks spawn real Windows processes. Keep them away from the user's real
// OpenCode auth database and Claude credential file, which are never read here.
vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(async () => ({})),
}));

const fixtureScope = vi.hoisted(() => ({ root: "" }));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    // Only this test's temp fixtures are readable; the user's real Claude login is never read.
    readFile: vi.fn(async (path: string, options: BufferEncoding) => {
      if (fixtureScope.root && String(path).startsWith(fixtureScope.root)) {
        return actual.readFile(path, options);
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
  };
});

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: vi.fn(
    async (params: { providerId: string }) => `identity:${params.providerId}`,
  ),
  composeResolvedAuthIdentities: vi.fn(),
}));

import { homedir } from "node:os";
import { readFile } from "fs/promises";
import {
  clearAnthropicDiagnosticsCacheForTests,
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  resolveAnthropicAuthIdentity,
} from "../src/lib/anthropic.js";
import { deriveResolvedAuthIdentity } from "../src/lib/resolved-auth-identity.js";

/**
 * A cmd.exe shim that behaves like `claude` for the two commands the probe runs.
 * Keep parentheses out of `echo` text inside `if` blocks: an unescaped `)` closes the block.
 */
function claudeShim(version: string, authenticated: boolean): string {
  return [
    "@echo off",
    'if "%~1"=="--version" (',
    `  echo ${version} Claude Code`,
    "  exit /b 0",
    ")",
    'if "%~1"=="auth" (',
    `  echo {"authenticated": ${authenticated ? "true" : "false"}}`,
    "  exit /b 0",
    ")",
    "exit /b 2",
    "",
  ].join("\r\n");
}

/**
 * A cmd.exe shim whose `auth status --json` reports the config directory the CLI uses.
 * Omitting `configDirectory` models a CLI build that reports no directory of its own.
 */
function claudeShimReportingConfigDirectory(configDirectory?: string): string {
  const report = JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    configDirectory,
  });
  return [
    "@echo off",
    'if "%~1"=="--version" (',
    "  echo 9.9.9 Claude Code",
    "  exit /b 0",
    ")",
    'if "%~1"=="auth" (',
    `  echo ${report}`,
    "  exit /b 0",
    ")",
    "exit /b 2",
    "",
  ].join("\r\n");
}

describe.runIf(process.platform === "win32")(
  "Claude CLI Windows cmd.exe bridge (real spawn)",
  () => {
    let root: string;
    let spacedBin: string;
    let pathBin: string;
    const originalPath = process.env.PATH;
    const originalClaudeConfigDirectory = process.env["CLAUDE_CONFIG_DIR"];

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "oc quota claude "));
      fixtureScope.root = root;
      spacedBin = join(root, "claude bin with spaces");
      pathBin = join(root, "path dir");
      await mkdir(spacedBin, { recursive: true });
      await mkdir(pathBin, { recursive: true });
      await writeFile(join(spacedBin, "claude.cmd"), claudeShim("9.9.9", true));
      await writeFile(join(pathBin, "claude.cmd"), claudeShim("1.0.0", true));
    });

    afterAll(async () => {
      process.env.PATH = originalPath;
      if (originalClaudeConfigDirectory === undefined) {
        delete process.env["CLAUDE_CONFIG_DIR"];
      } else {
        process.env["CLAUDE_CONFIG_DIR"] = originalClaudeConfigDirectory;
      }
      await rm(root, { recursive: true, force: true });
    });

    beforeEach(() => {
      clearAnthropicDiagnosticsCacheForTests();
      // The spawned CLI inherits this environment; a developer's own CLAUDE_CONFIG_DIR must not leak in.
      delete process.env["CLAUDE_CONFIG_DIR"];
    });

    it("runs a configured .cmd shim whose folder path contains spaces", async () => {
      const shim = join(spacedBin, "claude.cmd");

      const diagnostics = await getAnthropicDiagnostics({
        binaryPath: shim,
        useClaudeCodeCredentials: true,
      });

      expect(diagnostics.installed).toBe(true);
      expect(diagnostics.version).toBe("9.9.9");
      expect(diagnostics.authStatus).toBe("authenticated");
      expect(diagnostics.binaryPath).toBe(shim);
    });

    it("resolves the default bare claude command through PATH inside cmd.exe", async () => {
      process.env.PATH = `${pathBin};${originalPath ?? ""}`;

      const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });

      expect(diagnostics.installed).toBe(true);
      expect(diagnostics.version).toBe("1.0.0");
      expect(diagnostics.binaryPath).toBe("claude (PATH)");
    });

    it("prefers the configured binary path over the bare claude command on PATH", async () => {
      process.env.PATH = `${pathBin};${originalPath ?? ""}`;

      const diagnostics = await getAnthropicDiagnostics({
        binaryPath: join(spacedBin, "claude.cmd"),
        useClaudeCodeCredentials: true,
      });

      expect(diagnostics.version).toBe("9.9.9");
    });

    it("refuses a configured path that would break out of the cmd.exe command line", async () => {
      const sentinel = join(root, "pwned.txt");
      const hostile = `${join(spacedBin, "claude.cmd")}" & echo pwned> "${sentinel}" & "x.cmd`;

      await expect(
        getAnthropicDiagnostics({ binaryPath: hostile, useClaudeCodeCredentials: true }),
      ).rejects.toThrow(/cannot be passed safely through cmd\.exe/u);
      await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("reads the Claude login from the config directory the real CLI reports", async () => {
      vi.mocked(deriveResolvedAuthIdentity).mockClear();
      const configDirectory = join(root, "reported config");
      const shimDirectory = join(root, "reported shim");
      await mkdir(configDirectory, { recursive: true });
      await mkdir(shimDirectory, { recursive: true });
      await writeFile(
        join(configDirectory, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "reported-dir-token" } }),
      );
      await writeFile(
        join(shimDirectory, "claude.cmd"),
        claudeShimReportingConfigDirectory(configDirectory),
      );

      await resolveAnthropicAuthIdentity({
        binaryPath: join(shimDirectory, "claude.cmd"),
        useClaudeCodeCredentials: true,
      });

      expect(deriveResolvedAuthIdentity).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "anthropic:claude-code-route",
          principal: { kind: "credential", value: "reported-dir-token" },
        }),
      );
    });

    it("does not read the default Claude login when the reported config directory has none", async () => {
      vi.mocked(deriveResolvedAuthIdentity).mockClear();
      vi.mocked(readFile).mockClear();
      const configDirectory = join(root, "reported empty config");
      const shimDirectory = join(root, "reported empty shim");
      await mkdir(configDirectory, { recursive: true });
      await mkdir(shimDirectory, { recursive: true });
      await writeFile(
        join(shimDirectory, "claude.cmd"),
        claudeShimReportingConfigDirectory(configDirectory),
      );

      await expect(
        resolveAnthropicAuthIdentity({
          binaryPath: join(shimDirectory, "claude.cmd"),
          useClaudeCodeCredentials: true,
        }),
      ).resolves.toBeNull();
      expect(deriveResolvedAuthIdentity).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalledWith(
        join(homedir(), ".claude", ".credentials.json"),
        "utf8",
      );
    });

    it("reads the login from CLAUDE_CONFIG_DIR through the real CLI when it omits configDirectory", async () => {
      vi.mocked(deriveResolvedAuthIdentity).mockClear();
      vi.mocked(readFile).mockClear();
      const envConfigDirectory = join(root, "env config with spaces");
      const shimDirectory = join(root, "env shim");
      await mkdir(envConfigDirectory, { recursive: true });
      await mkdir(shimDirectory, { recursive: true });
      await writeFile(
        join(envConfigDirectory, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "env-config-token" } }),
      );
      await writeFile(join(shimDirectory, "claude.cmd"), claudeShimReportingConfigDirectory());
      process.env["CLAUDE_CONFIG_DIR"] = envConfigDirectory;

      await resolveAnthropicAuthIdentity({
        binaryPath: join(shimDirectory, "claude.cmd"),
        useClaudeCodeCredentials: true,
      });

      expect(deriveResolvedAuthIdentity).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "anthropic:claude-code-route",
          principal: { kind: "credential", value: "env-config-token" },
        }),
      );
      expect(readFile).not.toHaveBeenCalledWith(
        join(homedir(), ".claude", ".credentials.json"),
        "utf8",
      );
    });

    it("sees a Claude CLI login that appears after an earlier unauthenticated check", async () => {
      const freshBin = join(root, "fresh login");
      await mkdir(freshBin, { recursive: true });
      const shim = join(freshBin, "claude.cmd");
      await writeFile(shim, claudeShim("9.9.9", false));

      await expect(
        hasAnthropicCredentialsConfigured({ binaryPath: shim, useClaudeCodeCredentials: true }),
      ).resolves.toBe(false);

      await writeFile(shim, claudeShim("9.9.9", true));

      await expect(
        hasAnthropicCredentialsConfigured({ binaryPath: shim, useClaudeCodeCredentials: true }),
      ).resolves.toBe(true);
    });
  },
);
