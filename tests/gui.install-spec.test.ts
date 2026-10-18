import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyInitInstallerPlan,
  type InitInstallerSelections,
  planInitInstaller,
  QUOTA_PLUGIN_SPEC_ENV,
  runInitInstaller,
} from "../src/lib/init-installer.js";
import { parseJsonOrJsonc } from "../src/lib/jsonc.js";

vi.mock("../src/lib/opencode-version.js", () => ({
  detectOpenCodeMajor: async () => 2,
}));

// A stable running package resolves the default install spec to the npm latest tag.
vi.mock("../src/lib/version.js", () => ({
  getPackageVersion: async () => "5.0.3",
}));

const LOCAL_PACK_SPEC = "file:./opencode-quota-gui-5.0.0.tgz";
const UPSTREAM_PACKAGE_SPEC = "@slkiser/opencode-quota@latest";

function installerSelections(
  overrides: Partial<InitInstallerSelections> = {},
): InitInstallerSelections {
  return {
    interfaces: "tui",
    scope: "project",
    quotaUi: ["toast"],
    providerMode: "auto",
    manualProviders: [],
    formatStyle: "singleWindow",
    percentDisplayMode: "remaining",
    showSessionTokens: true,
    ...overrides,
  };
}

function readJson(path: string): any {
  const resolvedPath = !existsSync(path) && path.endsWith(".json") ? `${path}c` : path;
  return parseJsonOrJsonc(readFileSync(resolvedPath, "utf8"), resolvedPath.endsWith(".jsonc"));
}

function createPromptStub() {
  const selectValues: unknown[] = [
    "tui",
    "project",
    "jsonc",
    "inline",
    "auto",
    "singleWindow",
    "remaining",
    "yes",
    "current",
  ];
  const multiselectValues: unknown[] = [["toast"], ["toast"]];
  const confirmValues: unknown[] = [true, true, true, true, true, true];
  const outroCalls: string[] = [];
  const errorCalls: string[] = [];

  return {
    intro: () => {},
    outro: (message: string) => {
      outroCalls.push(message);
    },
    select: async () => selectValues.shift(),
    multiselect: async () => multiselectValues.shift(),
    confirm: async () => confirmValues.shift(),
    isCancel: (value: unknown) => value === Symbol.for("cancel"),
    log: {
      info: () => {},
      success: () => {},
      error: (message: string) => {
        errorCalls.push(message);
      },
    },
    outroCalls,
    errorCalls,
  };
}

describe("GUI install spec safety", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-gui-install-"));
    delete process.env[QUOTA_PLUGIN_SPEC_ENV];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env[QUOTA_PLUGIN_SPEC_ENV];
  });

  it("installs the explicit local pack spec for new installs instead of the upstream package", async () => {
    const plan = await planInitInstaller({
      cwd: tempDir,
      selections: installerSelections(),
      pluginSpec: LOCAL_PACK_SPEC,
    });
    await applyInitInstallerPlan(plan);

    const raw = readFileSync(join(tempDir, "opencode.jsonc"), "utf8");
    expect(readJson(join(tempDir, "opencode.jsonc")).plugin).toEqual([LOCAL_PACK_SPEC]);
    expect(raw).not.toContain("@slkiser/opencode-quota");
  });

  it("installs the canonical opencode-quota-gui release spec without an explicit local pack", async () => {
    const plan = await planInitInstaller({
      cwd: tempDir,
      selections: installerSelections(),
    });
    await applyInitInstallerPlan(plan);

    const raw = readFileSync(join(tempDir, "opencode.jsonc"), "utf8");
    expect(readJson(join(tempDir, "opencode.jsonc")).plugin).toEqual(["opencode-quota-gui@latest"]);
    expect(raw).not.toContain("@slkiser/opencode-quota");
  });

  it("accepts the explicit spec from OPENCODE_QUOTA_PLUGIN_SPEC", async () => {
    process.env[QUOTA_PLUGIN_SPEC_ENV] = LOCAL_PACK_SPEC;

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(plan);

    expect(readJson(join(tempDir, "opencode.jsonc")).plugin).toEqual([LOCAL_PACK_SPEC]);
  });

  it("refuses an explicit spec that points at the upstream package", async () => {
    const error = await planInitInstaller({
      cwd: tempDir,
      selections: installerSelections(),
      pluginSpec: UPSTREAM_PACKAGE_SPEC,
    }).catch((reason: Error) => reason);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected an Error");
    expect(error.message).toMatch(/upstream @slkiser\/opencode-quota/i);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("still recognizes existing legacy installs without requiring a spec", async () => {
    writeFileSync(
      join(tempDir, "opencode.json"),
      JSON.stringify({ plugin: ["@slkiser/opencode-quota@latest"] }),
      "utf8",
    );

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    expect(opencodeEdit?.addedPlugins).toEqual([]);

    await applyInitInstallerPlan(plan);
    expect(readJson(join(tempDir, "opencode.jsonc")).plugin).toEqual([
      "@slkiser/opencode-quota@latest",
    ]);
  });

  it("stays idempotent for an install that used the explicit local pack", async () => {
    const firstPlan = await planInitInstaller({
      cwd: tempDir,
      selections: installerSelections(),
      pluginSpec: LOCAL_PACK_SPEC,
    });
    await applyInitInstallerPlan(firstPlan);

    const secondPlan = await planInitInstaller({
      cwd: tempDir,
      selections: installerSelections(),
      pluginSpec: LOCAL_PACK_SPEC,
    });
    expect(secondPlan.edits.find((edit) => edit.kind === "opencode")?.changed).toBe(false);
  });

  it("recognizes its own package identity as an installed quota plugin", async () => {
    writeFileSync(
      join(tempDir, "opencode.json"),
      JSON.stringify({ plugin: ["opencode-quota-gui@latest"] }),
      "utf8",
    );

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    expect(opencodeEdit?.addedPlugins).toEqual([]);
  });

  it("installs the canonical release spec through runInitInstaller without an explicit local pack", async () => {
    const prompts = createPromptStub();

    const code = await runInitInstaller({
      cwd: tempDir,
      // SAFETY: the stub implements every prompt the installer consumes
      // (intro/outro/select/multiselect/confirm/isCancel/log).
      prompts: prompts as Parameters<typeof runInitInstaller>[0]["prompts"],
      env: {},
    });

    expect(code).toBe(0);
    expect(prompts.errorCalls).toEqual([]);
    expect(readJson(join(tempDir, "opencode.jsonc")).plugin).toEqual(["opencode-quota-gui@latest"]);
  });

  it("installs the explicit pack through runInitInstaller", async () => {
    const prompts = createPromptStub();

    const code = await runInitInstaller({
      cwd: tempDir,
      // SAFETY: the stub implements every prompt the installer consumes
      // (intro/outro/select/multiselect/confirm/isCancel/log).
      prompts: prompts as Parameters<typeof runInitInstaller>[0]["prompts"],
      pluginSpec: LOCAL_PACK_SPEC,
    });

    expect(code).toBe(0);
    expect(readJson(join(tempDir, "opencode.jsonc")).plugin).toEqual([LOCAL_PACK_SPEC]);
  });
});
