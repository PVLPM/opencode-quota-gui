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
  const selectValues: unknown[] = ["project", "auto", "remaining"];
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
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-gui-install-"));
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = join(tempDir, "global-config");
    delete process.env[QUOTA_PLUGIN_SPEC_ENV];
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
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
    expect(readJson(join(tempDir, "opencode.jsonc")).plugins).toEqual([LOCAL_PACK_SPEC]);
    expect(raw).not.toContain("@slkiser/opencode-quota");
  });

  it("installs the canonical opencode-quota-gui release spec without an explicit local pack", async () => {
    const plan = await planInitInstaller({
      cwd: tempDir,
      selections: installerSelections(),
    });
    await applyInitInstallerPlan(plan);

    const raw = readFileSync(join(tempDir, "opencode.jsonc"), "utf8");
    expect(readJson(join(tempDir, "opencode.jsonc")).plugins).toEqual([
      "opencode-quota-gui@latest",
    ]);
    expect(raw).not.toContain("@slkiser/opencode-quota");
  });

  it("accepts the explicit spec from OPENCODE_QUOTA_PLUGIN_SPEC", async () => {
    process.env[QUOTA_PLUGIN_SPEC_ENV] = LOCAL_PACK_SPEC;

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(plan);

    expect(readJson(join(tempDir, "opencode.jsonc")).plugins).toEqual([LOCAL_PACK_SPEC]);
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

  it("preserves an existing legacy install and adds the GUI entry without requiring a spec", async () => {
    writeFileSync(
      join(tempDir, "opencode.json"),
      JSON.stringify({ plugin: ["@slkiser/opencode-quota@latest"] }),
      "utf8",
    );

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    expect(opencodeEdit?.addedPlugins).toEqual(["plugins: opencode-quota-gui@latest"]);

    await applyInitInstallerPlan(plan);
    expect(readJson(join(tempDir, "opencode.jsonc"))).toEqual({
      plugin: ["@slkiser/opencode-quota@latest"],
      plugins: ["opencode-quota-gui@latest"],
    });
  });

  it("deduplicates GUI entries while preserving upstream entries and unrelated plugins", async () => {
    writeFileSync(
      join(tempDir, "opencode.jsonc"),
      JSON.stringify({
        plugins: [
          "before",
          "opencode-quota-gui@latest",
          "between",
          UPSTREAM_PACKAGE_SPEC,
          { package: "unrelated-plugin", options: { keep: true } },
          "after",
        ],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(plan);

    expect(readJson(join(tempDir, "opencode.jsonc")).plugins).toEqual([
      "before",
      "opencode-quota-gui@latest",
      "between",
      UPSTREAM_PACKAGE_SPEC,
      { package: "unrelated-plugin", options: { keep: true } },
      "after",
    ]);
  });

  it("deduplicates the same GUI plugin found in both singular and plural arrays", async () => {
    writeFileSync(
      join(tempDir, "opencode.jsonc"),
      JSON.stringify({
        plugin: ["legacy-before", "opencode-quota-gui@latest", "legacy-after"],
        plugins: ["native-before", "opencode-quota-gui@latest", "native-after"],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(plan);

    expect(readJson(join(tempDir, "opencode.jsonc"))).toEqual({
      plugin: ["legacy-before", "legacy-after"],
      plugins: ["native-before", "opencode-quota-gui@latest", "native-after"],
    });
  });

  it("preserves upstream entries in the legacy array beside a native GUI entry", async () => {
    writeFileSync(
      join(tempDir, "opencode.jsonc"),
      JSON.stringify({
        plugins: ["before", "opencode-quota-gui@latest", "after"],
        plugin: ["legacy-before", UPSTREAM_PACKAGE_SPEC, "legacy-after"],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(plan);

    expect(readJson(join(tempDir, "opencode.jsonc"))).toEqual({
      plugin: ["legacy-before", UPSTREAM_PACKAGE_SPEC, "legacy-after"],
      plugins: ["before", "opencode-quota-gui@latest", "after"],
    });
    expect(plan.summaryLines.join("\n")).not.toContain("remove duplicate quota plugin");
  });

  it("preserves an upstream legacy entry beside a verified local checkout", async () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "opencode-quota-gui" }),
      "utf8",
    );
    writeFileSync(join(tempDir, "server.ts"), "export {};", "utf8");
    writeFileSync(
      join(tempDir, "opencode.jsonc"),
      JSON.stringify({
        plugins: ["before", "./server.ts", "after"],
        plugin: ["legacy-before", UPSTREAM_PACKAGE_SPEC, "legacy-after"],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(plan);

    expect(readJson(join(tempDir, "opencode.jsonc"))).toEqual({
      plugin: ["legacy-before", UPSTREAM_PACKAGE_SPEC, "legacy-after"],
      plugins: ["before", "./server.ts", "after"],
    });
  });

  it("preserves a legacy-only upstream plugin spec and options while adding the GUI entry", async () => {
    writeFileSync(
      join(tempDir, "opencode.jsonc"),
      JSON.stringify({
        plugin: [
          "legacy-before",
          [UPSTREAM_PACKAGE_SPEC, { enabled: true, label: "preserve me" }],
          "legacy-after",
        ],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(plan);

    expect(readJson(join(tempDir, "opencode.jsonc"))).toEqual({
      plugin: [
        "legacy-before",
        [UPSTREAM_PACKAGE_SPEC, { enabled: true, label: "preserve me" }],
        "legacy-after",
      ],
      plugins: ["opencode-quota-gui@latest"],
    });
  });

  it("treats object and tuple options with reordered keys as equivalent duplicates", async () => {
    writeFileSync(
      join(tempDir, "opencode.jsonc"),
      JSON.stringify({
        plugin: [["opencode-quota-gui@latest", { beta: 2, alpha: 1 }]],
        plugins: [{ package: "opencode-quota-gui@latest", options: { alpha: 1, beta: 2 } }],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(plan);

    expect(readJson(join(tempDir, "opencode.jsonc"))).toEqual({
      plugin: [],
      plugins: [{ package: "opencode-quota-gui@latest", options: { alpha: 1, beta: 2 } }],
    });
  });

  it("refuses conflicting plugin options across arrays without writing the config", async () => {
    const path = join(tempDir, "opencode.jsonc");
    writeFileSync(
      path,
      JSON.stringify({
        plugin: [{ package: "opencode-quota-gui@latest", options: { enabled: false } }],
        plugins: [{ package: "opencode-quota-gui@latest", options: { enabled: true } }],
      }),
      "utf8",
    );
    const before = readFileSync(path, "utf8");

    await expect(
      planInitInstaller({ cwd: tempDir, selections: installerSelections() }),
    ).rejects.toThrow("different options");

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(tempDir)).toEqual(["opencode.jsonc"]);
  });

  it("preserves unknown object metadata when an explicit spec deduplicates across arrays", async () => {
    writeFileSync(
      join(tempDir, "opencode.jsonc"),
      JSON.stringify({
        plugin: [
          "legacy-before",
          {
            package: "opencode-quota-gui@latest",
            options: { enabled: true },
            customMetadata: { owner: "kept" },
          },
          "legacy-after",
        ],
        plugins: [
          "native-before",
          {
            package: "opencode-quota-gui@latest",
            options: { enabled: true },
            customMetadata: { owner: "kept" },
          },
          "native-after",
        ],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: tempDir,
      selections: installerSelections(),
      pluginSpec: LOCAL_PACK_SPEC,
    });
    await applyInitInstallerPlan(plan);

    expect(readJson(join(tempDir, "opencode.jsonc"))).toEqual({
      plugin: ["legacy-before", "legacy-after"],
      plugins: [
        "native-before",
        {
          package: LOCAL_PACK_SPEC,
          options: { enabled: true },
          customMetadata: { owner: "kept" },
        },
        "native-after",
      ],
    });
  });

  it("preserves tuple tails when the environment spec deduplicates across arrays", async () => {
    process.env[QUOTA_PLUGIN_SPEC_ENV] = LOCAL_PACK_SPEC;
    writeFileSync(
      join(tempDir, "opencode.jsonc"),
      JSON.stringify({
        plugin: [
          "legacy-before",
          ["opencode-quota-gui@latest", { beta: 2, alpha: 1 }, "preserve tuple tail"],
          "legacy-after",
        ],
        plugins: [
          "native-before",
          ["opencode-quota-gui@latest", { alpha: 1, beta: 2 }, "preserve tuple tail"],
          "native-after",
        ],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(plan);

    expect(readJson(join(tempDir, "opencode.jsonc"))).toEqual({
      plugin: ["legacy-before", "legacy-after"],
      plugins: [
        "native-before",
        [LOCAL_PACK_SPEC, { alpha: 1, beta: 2 }, "preserve tuple tail"],
        "native-after",
      ],
    });
  });

  it("refuses to discard differing unknown object metadata across arrays", async () => {
    const path = join(tempDir, "opencode.jsonc");
    writeFileSync(
      path,
      JSON.stringify({
        plugin: [
          {
            package: "opencode-quota-gui@latest",
            options: { enabled: true },
            metadata: { owner: "legacy" },
          },
        ],
        plugins: [
          {
            package: "opencode-quota-gui@latest",
            options: { enabled: true },
            metadata: { owner: "native" },
          },
        ],
      }),
      "utf8",
    );
    const before = readFileSync(path, "utf8");

    await expect(
      planInitInstaller({ cwd: tempDir, selections: installerSelections() }),
    ).rejects.toThrow("different options");

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(tempDir)).toEqual(["opencode.jsonc"]);
  });

  it("refuses to discard a differing tuple tail across arrays", async () => {
    const path = join(tempDir, "opencode.jsonc");
    writeFileSync(
      path,
      JSON.stringify({
        plugin: [["opencode-quota-gui@latest", { enabled: true }, "legacy tail"]],
        plugins: [["opencode-quota-gui@latest", { enabled: true }, "native tail"]],
      }),
      "utf8",
    );
    const before = readFileSync(path, "utf8");

    await expect(
      planInitInstaller({ cwd: tempDir, selections: installerSelections() }),
    ).rejects.toThrow("different options");

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(tempDir)).toEqual(["opencode.jsonc"]);
  });

  it("is byte-idempotent after cross-array duplicate cleanup", async () => {
    const path = join(tempDir, "opencode.jsonc");
    writeFileSync(
      path,
      JSON.stringify({
        plugins: ["before", "opencode-quota-gui@latest", "after"],
        plugin: ["legacy-before", "opencode-quota-gui@latest", "legacy-after"],
      }),
      "utf8",
    );

    const firstPlan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(firstPlan);
    const afterCleanup = readFileSync(path, "utf8");
    expect(readJson(path)).toEqual({
      plugin: ["legacy-before", "legacy-after"],
      plugins: ["before", "opencode-quota-gui@latest", "after"],
    });

    const secondPlan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    expect(secondPlan.edits.find((edit) => edit.kind === "opencode")?.changed).toBe(false);
    await applyInitInstallerPlan(secondPlan);
    expect(readFileSync(path, "utf8")).toBe(afterCleanup);
  });

  it("is byte-idempotent after implicit duplicate cleanup", async () => {
    const path = join(tempDir, "opencode.jsonc");
    writeFileSync(
      path,
      JSON.stringify({
        plugins: ["before", "opencode-quota-gui@latest", "opencode-quota-gui@latest", "after"],
      }),
      "utf8",
    );

    const firstPlan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    await applyInitInstallerPlan(firstPlan);
    expect(readJson(path).plugins).toEqual(["before", "opencode-quota-gui@latest", "after"]);
    const afterCleanup = readFileSync(path, "utf8");

    const secondPlan = await planInitInstaller({ cwd: tempDir, selections: installerSelections() });
    expect(secondPlan.edits.find((edit) => edit.kind === "opencode")?.changed).toBe(false);
    await applyInitInstallerPlan(secondPlan);
    expect(readFileSync(path, "utf8")).toBe(afterCleanup);
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
    expect(readJson(join(tempDir, "opencode.jsonc")).plugins).toEqual([
      "opencode-quota-gui@latest",
    ]);
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
    expect(readJson(join(tempDir, "opencode.jsonc")).plugins).toEqual([LOCAL_PACK_SPEC]);
  });
});
