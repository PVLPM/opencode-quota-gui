import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validateQuotaProviders } from "../src/lib/quota-providers.js";
import {
  hasMarkdownLinkTo,
  readFencedCodeBlocks,
  readMarkdownParagraphContaining,
  readMarkdownSection,
} from "./helpers/markdown-document.js";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("GUI documentation consistency", () => {
  it("keeps the documented canonical OpenRouter example valid", () => {
    expect(
      validateQuotaProviders([
        {
          id: "openrouter-primary",
          providerId: "openrouter",
          label: "OpenRouter Primary",
          mode: "remote-api",
          url: "https://openrouter.ai/api/v1/key",
          format: "openrouter-key-v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      ]),
    ).toEqual({
      value: [
        {
          id: "openrouter-primary",
          providerId: "openrouter",
          label: "OpenRouter Primary",
          mode: "remote-api",
          url: "https://openrouter.ai/api/v1/key",
          format: "openrouter-key-v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      ],
      issues: [],
    });
  });

  it("documents only the canonical GUI configuration and its supported custom-provider path", () => {
    const readme = read("README.md");
    const configuration = read("docs/readme/configuration.md");
    const providers = read("docs/readme/providers.md");
    const troubleshooting = read("docs/readme/troubleshooting.md");
    const manualInstall = read("docs/readme/manual-install.md");
    const external = read("docs/readme/external-integration.md");

    expect(readme).not.toContain("experimental.quotaToast");
    expect(readme).not.toContain("apiKeyEnv");
    expect(readme).not.toContain("provider add");

    for (const document of [configuration, providers, troubleshooting, manualInstall, external]) {
      expect(document).not.toContain("accounting-v1");
      expect(document).not.toContain("npx opencode-quota-gui provider add");
      expect(document).not.toContain("/quota_status");
    }

    expect(configuration).toContain("~/.config/opencode/opencode-quota-gui/config.jsonc");
    expect(configuration).toContain("quotaProviders");
    expect(configuration).toContain("JSONC");
    expect(configuration).toContain("canonical");
    expect(configuration).toContain("does not read inherited legacy layers at runtime");
    expect(configuration).toContain("opencode.db");
    expect(configuration).toContain("~/.local/state/opencode/opencode-quota-gui/quota-providers/");

    for (const document of [configuration, providers]) {
      expect(document).toContain("apiKeyEnv");
      expect(document).toContain("provider.<providerId>.options.apiKey");
      expect(document).toContain("opencode.db");
      expect(document).toContain("quota-providers");
    }

    const providerGuideCustomProviders = readMarkdownSection(providers, /^Custom providers$/);
    expect(providerGuideCustomProviders).toContain("limited to 256 KiB");
    expect(providerGuideCustomProviders).toContain("limited to 100 rows");
    expect(providerGuideCustomProviders).toContain(
      "128 objects, 384 object properties, and 640 array elements",
    );
    expect(providerGuideCustomProviders).toContain("at most 32 container levels");
    expect(providerGuideCustomProviders).toContain("absolute magnitude at most `1e15`");
    expect(providerGuideCustomProviders).toContain("offsets through `±14:00`");
    expect(providerGuideCustomProviders).toContain("Metric compatibility and fixed output");
    expect(providerGuideCustomProviders).toContain("`used-limit`");
    expect(providerGuideCustomProviders).toContain("Pair denominators");
    expect(providerGuideCustomProviders).toContain("`unit`");
    expect(providerGuideCustomProviders).toContain("`unitPosition`");
    expect(providerGuideCustomProviders).toContain("percentage");
    expect(providerGuideCustomProviders).toContain("status");

    const configurationCustomProviders = readMarkdownSection(configuration, /^Custom providers$/);
    expect(configurationCustomProviders).toContain("global");
    expect(configurationCustomProviders).toContain("`modelIds`");
    expect(configurationCustomProviders).toContain("`onlyCurrentModel`");
    expect(configurationCustomProviders).toContain("pricingModelMap");
    expect(configurationCustomProviders).toContain("budget percentage");
    expect(configurationCustomProviders).toContain("unavailable");
    expect(configurationCustomProviders).toContain("never ask for or store a secret");
    expect(configurationCustomProviders).toContain("Definitions are not imported");

    const secretParagraph = readMarkdownParagraphContaining(
      providerGuideCustomProviders,
      "secrets",
      "configuration",
    );
    expect(secretParagraph).toMatch(/\b(?:never|must not|cannot|forbidden)\b/i);

    const externalSection = readMarkdownSection(external, /^Supported integration surface$/);
    expect(externalSection).toContain("No public API");
    expect(externalSection).toContain("/api/v1");
    expect(externalSection).toContain("internal");
    expect(externalSection).not.toContain("show --json");
    expect(externalSection).not.toContain("quota-export.json");
  });

  it("keeps Settings canonical-only and legacy import detection separate", () => {
    const readme = read("README.md");
    const configuration = read("docs/readme/configuration.md");
    const updating = read("docs/readme/updating.md");
    const troubleshooting = read("docs/readme/troubleshooting.md");
    const external = read("docs/readme/external-integration.md");

    for (const document of [readme, configuration, updating, troubleshooting]) {
      for (const stale of [
        "Workspace override",
        "Project override",
        "Legacy override",
        "project and workspace overrides remain effective",
        "wins over the global legacy",
      ]) {
        expect(document, stale).not.toContain(stale);
      }
    }

    expect(configuration).toContain(
      "Settings values, provenance, the dashboard port, and visibility lists come only from the canonical file and defaults.",
    );
    expect(configuration).toContain(
      "The separate import preview is the only path that reads inherited legacy values.",
    );
    expect(readme).toContain(
      "Settings values, source labels, the port, and visibility lists come only from the canonical file and defaults, regardless of whether OpenCode uses `opencode.json` or `opencode.jsonc`.",
    );
    expect(updating).toContain("Settings shows canonical values only");
    expect(troubleshooting).toContain("[opencode-quota-gui]");
    expect(external).toContain("report metadata");
  });

  it("keeps README external references current", () => {
    const readme = read("README.md");
    const support = readMarkdownSection(readme, /^Support$/);

    for (const url of [
      "https://opencode.ai/v2/docs/",
      "https://opencode.ai/v2/docs/config/",
      "https://opencode.ai/v2/docs/plugins/",
      "https://models.dev/",
      "https://nodejs.org/en/download",
    ]) {
      expect(hasMarkdownLinkTo(support, url), url).toBe(true);
    }
    expect(readme).not.toContain("https://opencode.ai/docs/");
  });

  it("documents the approved install shape and dashboard-only surfaces", () => {
    const readme = read("README.md");
    const manualInstall = read("docs/readme/manual-install.md");

    for (const document of [readme, manualInstall]) {
      expect(document).toContain("http://localhost:4144/quota");
      expect(document).toContain("~/.config/opencode/opencode.json");
      expect(document).not.toContain('"plugin": [');
      expect(document).toContain('"plugins": ["opencode-quota-gui"]');
    }

    expect(readme).toContain("opencode plugin add opencode-quota-gui");
    expect(manualInstall).toContain("~/.config/opencode/plugins/");
    expect(manualInstall).toContain(".opencode/plugins/");
    expect(manualInstall).toContain("Restart OpenCode");
  });

  it("keeps custom-provider copy-paste integrations independent of entry order", () => {
    const external = read("docs/readme/external-integration.md");
    expect(external).not.toContain("entries[0].percentRemaining");
    expect(external).toContain("not a public API");
  });

  it("documents optional host-owned OpenTelemetry without promising a public API", () => {
    const readme = read("README.md");
    const configuration = read("docs/readme/configuration.md");
    const external = read("docs/readme/external-integration.md");

    expect(external).not.toContain("No supported export file, OpenTelemetry output");
    expect(external).not.toMatch(/no supported OpenTelemetry/i);
    expect(external).toContain("off by default");
    expect(external).toContain("opencode.quota.consumed");
    expect(external).toContain("opencode.quota.cache.age");
    expect(external).toContain("MeterProvider");
    expect(external).toContain("does not make extra provider requests");
    expect(external).toContain("not a public API");
    expect(external).toContain("Export files");
    expect(external).toContain("RPC methods remain unsupported");

    expect(readme).toContain("OpenTelemetry (optional)");
    expect(readme).toContain("opencode.quota.consumed");
    expect(readme).toContain("opencode.quota.cache.age");
    expect(readme).toContain("off by default");

    expect(configuration).toContain("telemetry.enabled");
    expect(configuration).toContain("opencode.quota.consumed");
    expect(configuration).toContain("opencode.quota.cache.age");
    expect(configuration).toContain("does not create a provider");
  });

  it("documents the MiMo credential sidecar in the GUI namespace, separate from behavior config", () => {
    const configuration = read("docs/readme/configuration.md");
    const providers = read("docs/readme/providers.md");
    const troubleshooting = read("docs/readme/troubleshooting.md");

    expect(configuration).toContain("Provider credential sidecars");
    expect(configuration).toContain("opencode-quota-gui/mimo.json");
    expect(configuration).toContain("not part of the canonical behavior config");

    for (const document of [providers, troubleshooting]) {
      expect(document).toContain("opencode-quota-gui/mimo.json");
      expect(document).toContain("MIMO_USAGE_COOKIE");
    }

    expect(providers).not.toContain("create the user/global file `opencode-quota/mimo.json`");
    expect(providers).toContain(
      "does not read, copy, migrate, or write upstream `opencode-quota/mimo.json`",
    );
    expect(troubleshooting).not.toContain("create trusted user/global `opencode-quota/mimo.json`");
    expect(troubleshooting).toContain("does not read upstream `opencode-quota/mimo.json`");
  });

  it("keeps behavior settings global for project installs and leaves sibling config.json untouched", () => {
    const readme = read("README.md");
    const manualInstall = read("docs/readme/manual-install.md");
    const configuration = read("docs/readme/configuration.md");
    const updating = read("docs/readme/updating.md");

    for (const document of [readme, manualInstall, configuration, updating]) {
      expect(document).toMatch(/behavior settings (?:are always global|remain global)/i);
      expect(document).toContain("preserved unchanged");
      // No installer conversion/import claim for the dormant sibling file.
      expect(document).not.toMatch(
        /(?:convert|converts|converted|imports?|imported) (?:an? )?(?:existing )?(?:sibling )?(?:GUI )?`?config\.json`?/i,
      );
    }

    expect(readme).toContain("project OpenCode plugin entry");
    expect(manualInstall).toContain("project OpenCode plugin entry");
    expect(configuration).toContain("does not create project behavior settings");
    expect(updating).toContain("project plugin install");
  });

  it("keeps the canonical example self-contained", () => {
    const configuration = read("docs/readme/configuration.md");
    const customProviders = readMarkdownSection(configuration, /^Custom providers$/);
    const json = readFencedCodeBlocks(customProviders).find(
      (block) => block.info === "jsonc" && block.content.includes('"quotaProviders"'),
    );
    expect(json, "canonical quotaProviders example").toBeDefined();
    const parsed = JSON.parse(
      json?.content
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n")
        .replace(/,\s*([}\]])/g, "$1") ?? "{}",
    ) as Record<string, unknown>;
    expect(parsed.quotaProviders).toBeInstanceOf(Array);
    expect(parsed.experimental).toBeUndefined();
  });
});
