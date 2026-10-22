import { readFileSync } from "fs";
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

describe("quota provider Phase 7 documentation consistency", () => {
  it("keeps the documented OpenRouter example valid", () => {
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

  it("keeps the README concise and the detailed provider guides complete", () => {
    const readme = read("README.md");
    const configuration = read("docs/readme/configuration.md");
    const providers = read("docs/readme/providers.md");
    const troubleshooting = read("docs/readme/troubleshooting.md");
    const external = read("docs/readme/external-integration.md");
    const manualInstall = read("docs/readme/manual-install.md");

    const readmeCommands = readMarkdownSection(readme, /^Commands$/);
    const readmeCustomProviders = readMarkdownSection(readme, /^Custom providers$/);
    const configurationCustomProviders = readMarkdownSection(configuration, /^Custom providers$/);
    const providerGuideCustomProviders = readMarkdownSection(providers, /^Custom providers$/);
    const troubleshootingProviderFixes = readMarkdownSection(troubleshooting, /^Provider fixes$/);
    const externalJsonBasics = readMarkdownSection(external, /^JSON basics$/);

    // The published product CLI (npx form); the upstream npx invocation is no longer documented.
    const providerAddCommand = "npx opencode-quota-gui provider add";
    expect(readmeCommands).toContain(providerAddCommand);
    expect(readmeCustomProviders).toContain(providerAddCommand);
    expect(
      hasMarkdownLinkTo(readmeCustomProviders, "docs/readme/providers.md#custom-providers"),
    ).toBe(true);
    expect(readme).not.toContain("experimental.quotaToast");
    expect(readme).not.toContain("apiKeyEnv");

    for (const document of [
      readme,
      configuration,
      providers,
      troubleshooting,
      external,
      manualInstall,
    ]) {
      expect(document).not.toContain("accounting-v1");
    }

    expect(configuration).toContain("provider add");
    expect(configuration).toContain("experimental.quotaToast");
    expect(configuration).toContain("quotaProviders");
    expect(configuration).toContain("JSONC");
    expect(configuration).toContain("do not duplicate it in a second file");

    for (const document of [configuration, providers]) {
      expect(document).toContain("apiKeyEnv");
      expect(document).toContain("provider.<providerId>.options.apiKey");
      expect(document).toContain("opencode.db");
      expect(document).toContain("quota-providers");
    }

    expect(configurationCustomProviders).toContain("global-only");
    expect(
      readMarkdownParagraphContaining(
        configurationCustomProviders,
        "`modelIds`",
        "`onlyCurrentModel`",
      ),
    ).toMatch(/`modelIds`[\s\S]*\bonly\b[\s\S]*`onlyCurrentModel`/);
    const pricingMapRule = readMarkdownParagraphContaining(
      configurationCustomProviders,
      "pricingModelMap",
      "successful automatic match",
    );
    expect(pricingMapRule).toMatch(
      /pricingModelMap[\s\S]*\b(?:cannot|must not|does not) override\b[\s\S]*\bsuccessful automatic match\b/i,
    );
    expect(
      readMarkdownParagraphContaining(
        configurationCustomProviders,
        "budget percentage",
        "unavailable",
      ),
    ).toMatch(/budget percentage[\s\S]*\b(?:reported|shown|marked) unavailable\b/i);
    expect(configurationCustomProviders).toContain("~/.local/state/opencode/opencode-quota/");
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
    expect(providerGuideCustomProviders).toContain('For `metric.type: "value"`');
    expect(providerGuideCustomProviders).toContain("Pair denominators");
    const unitRule = readMarkdownParagraphContaining(
      providerGuideCustomProviders,
      "`unit`",
      "`unitPosition`",
      "`percentage`",
      "`status`",
    );
    expect(unitRule).toMatch(
      /`unit`[\s\S]*`unitPosition`[\s\S]*\b(?:must|required to)\b[\s\S]*\btogether\b/i,
    );
    expect(unitRule).toMatch(
      /\b(?:forbidden|not allowed|must not appear)\b[\s\S]*`percentage`[\s\S]*`status`/i,
    );
    const secretRule = readMarkdownParagraphContaining(
      providerGuideCustomProviders,
      "secrets",
      "adapter display configuration",
    );
    expect(secretRule).toMatch(
      /\b(?:never|must not|cannot|forbidden)\b[\s\S]*\bsecrets\b[\s\S]*adapter display configuration/i,
    );
    expect(
      readMarkdownParagraphContaining(
        troubleshootingProviderFixes,
        "cached results",
        "substituted",
      ),
    ).toMatch(/cached results[\s\S]*\b(?:not|never) substituted\b/i);
    const hiddenDiagnostics = readMarkdownParagraphContaining(
      troubleshootingProviderFixes,
      "URLs",
      "request/response contents",
      "raw errors",
    );
    expect(hiddenDiagnostics).toMatch(
      /\b(?:hide|hides|hidden|exclude|excludes)\b[\s\S]*URLs[\s\S]*request\/response contents[\s\S]*raw errors/i,
    );
    expect(externalJsonBasics).toContain('"version": 2');
    expect(externalJsonBasics).toContain('providers["quota-providers"]');
    expect(externalJsonBasics).toContain("configured `quotaProviders` definition");
    expect(external).not.toContain("custom-sources");
    expect(external).not.toContain("Custom-provider");
    expect(externalJsonBasics).toContain('"sourceId": "openrouter-primary"');
    expect(externalJsonBasics).toContain('"sources": [');
    expect(externalJsonBasics).toContain('"id": "openrouter-primary"');
    expect(externalJsonBasics).toContain('"entryCount": 1');
    const sourceSummaryBlock = readFencedCodeBlocks(externalJsonBasics).find(
      (block) => block.info === "json" && block.content.includes('"sources"'),
    );
    if (sourceSummaryBlock === undefined) throw new Error("Source summary JSON example not found");
    const sourceSummaryExample = JSON.parse(`{${sourceSummaryBlock.content}}`) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(sourceSummaryExample.sources).toHaveLength(1);
    expect(Object.keys(sourceSummaryExample.sources[0]).sort()).toEqual(
      ["id", "providerId", "status", "entryCount"].sort(),
    );

    const sourceSummaryRule = readMarkdownParagraphContaining(
      externalJsonBasics,
      "Each summary",
      "`providerId`",
      "`status`",
      "`entryCount`",
    );
    expect(sourceSummaryRule).toMatch(/\bexactly\b/i);
    expect(sourceSummaryRule).toMatch(/\beffective `providerId`/i);
    expect(sourceSummaryRule).toMatch(/\bcoarse `status`/i);
    expect(sourceSummaryRule).toMatch(
      /failed mapping candidates?[\s\S]*aggregate provider[\s\S]*`partial`/i,
    );
    expect(
      readMarkdownParagraphContaining(externalJsonBasics, "raw provider responses", "public JSON"),
    ).toMatch(/raw provider responses[\s\S]*\b(?:excluded|omitted) from public JSON\b/i);
  });

  it("links to the authoritative external references used by the README", () => {
    const referenceSection = readMarkdownSection(read("README.md"), /^Reference$/);

    for (const url of [
      "https://opencode.ai/v2/docs/",
      "https://opencode.ai/v2/docs/config/",
      "https://opencode.ai/v2/docs/plugins/",
      "https://models.dev/",
      "https://nodejs.org/en/download",
    ]) {
      expect(hasMarkdownLinkTo(referenceSection, url), url).toBe(true);
    }
    expect(referenceSection).not.toContain("https://opencode.ai/docs/");
  });

  it("documents the OpenCode 2 plural plugins config and GUI-first install paths", () => {
    const readme = read("README.md");
    const manualInstall = read("docs/readme/manual-install.md");

    for (const document of [readme, manualInstall]) {
      expect(document).toContain("http://localhost:4144/quota");
      expect(document).toContain("~/.config/opencode/opencode.json");
      expect(document).not.toContain('"plugin": [');
    }

    expect(manualInstall).toContain('"plugins": ["opencode-quota-gui"]');
    expect(manualInstall).toContain("~/.config/opencode/plugins/");
    expect(manualInstall).toContain(".opencode/plugins/");
    expect(manualInstall).toContain("Restart OpenCode");
  });

  it("keeps current-version plugin examples plural while preserving historical OpenCode 1 references", () => {
    const updating = read("docs/readme/updating.md");
    const troubleshooting = read("docs/readme/troubleshooting.md");
    const providers = read("docs/readme/providers.md");

    expect(providers).toContain(
      '"plugins": ["cursor-opencode-provider/plugin/opencode2", "opencode-quota-gui"]',
    );
    expect(providers).not.toContain('"plugin": [');
    expect(providers).toContain(
      "the OpenCode Quota plugin entry in the `plugins` list of `opencode.json(c)`",
    );
    expect(troubleshooting).toContain("`plugins` list of `~/.config/opencode/opencode.json(c)`");
    expect(troubleshooting).not.toContain("`plugin` list");
    expect(updating).toContain("Add one entry to the `plugins` list");
    expect(updating).not.toContain('One `"plugin"` entry');
    expect(updating).toContain("legacy `plugin`");
    expect(updating).toContain('"plugin": ["@slkiser/opencode-quota@4"]');
    expect(updating).toContain("https://opencode.ai/v2/docs/");
    expect(updating).not.toContain("https://opencode.ai/docs/");
  });

  it("documents the installer and updater package-identity policy without contradiction", () => {
    const readme = read("README.md");
    const manualInstall = read("docs/readme/manual-install.md");
    const updating = read("docs/readme/updating.md");
    const flat = (document: string) => document.replace(/\s+/g, " ");

    // The old blanket claims that contradicted each other are gone.
    for (const document of [readme, manualInstall, updating]) {
      expect(document).not.toContain("never rewired silently");
    }
    expect(manualInstall).not.toContain("legacy upstream paths stay untouched");
    expect(updating).not.toContain("legacy `@slkiser/opencode-quota` entries are migrated");
    expect(
      /Replace or remove the old entry yourself/i.test(readme) &&
        /legacy `@slkiser\/opencode-quota` entries are migrated/i.test(updating),
    ).toBe(false);

    // Plain init retains an existing recognized spec (including upstream) without duplicating it.
    expect(flat(readme)).toContain("recognizes an existing quota entry");
    expect(flat(manualInstall)).toContain("Plain `init` recognizes that entry");
    for (const document of [readme, manualInstall]) {
      expect(flat(document)).toContain(
        "does not add a second `opencode-quota-gui` entry beside it",
      );
    }

    // Switching identity is explicit and previewed, not silent.
    expect(flat(readme)).toMatch(
      /To switch identity, run `init` or `update` with an explicit `OPENCODE_QUOTA_PLUGIN_SPEC` \(previewed before writing\)/,
    );

    // Update keeps moving specs as written and rewrites only non-moving specs; an explicit spec overrides both.
    const updateRules = flat(updating);
    expect(updateRules).toMatch(/non-moving\*\* quota specs to `opencode-quota-gui@latest`/);
    expect(updateRules).toContain("**Moving** specs stay exactly as written");
    expect(updateRules).toContain(
      "`opencode-quota-gui@latest`, `opencode-quota-gui@next`, `@slkiser/opencode-quota@latest`, `@slkiser/opencode-quota@next`, and `@slkiser/opencode-quota@4`",
    );
    expect(updateRules).toContain(
      "A moving upstream spec is therefore not silently renamed to `opencode-quota-gui`",
    );
    expect(updateRules).toContain(
      "With `OPENCODE_QUOTA_PLUGIN_SPEC` set, that exact spec is the target for recognized entries instead",
    );
    expect(updateRules).toContain("differing options stop the run before any write");

    // 1.0.0 is this package; 5.0.0 references are qualified upstream history.
    expect(flat(readme)).toContain(
      "This independent `opencode-quota-gui` package is version `1.0.0`",
    );
    expect(readme).toContain("### Breaking changes in upstream OpenCode Quota 5.0.0 (history)");
    expect(flat(readme)).toContain("inherited upstream OpenCode Quota 5.0.0 history");
    expect(flat(updating)).toContain(
      "This independent package, `opencode-quota-gui` `1.0.0`, runs only on OpenCode `2.0.16` or newer",
    );
    expect(flat(updating)).toContain(
      "What changed in the upstream OpenCode Quota `5.0.0` line (inherited history)",
    );
    expect(flat(readme)).not.toMatch(/`opencode-quota-gui` is `5\.0\.0`/);
  });

  it("keeps Dashboard settings, import, and precedence copy specific", () => {
    const readme = read("README.md");
    const manualInstall = read("docs/readme/manual-install.md");

    for (const stale of [
      "the same keys as the config file",
      "copy settings from legacy config files (global or project)",
      "shows the winning source for every key",
      "it wins even over project files",
    ]) {
      expect(readme, stale).not.toContain(stale);
    }

    expect(readme).toContain("The six legacy/TUI-only controls are hidden");
    expect(readme).toContain("only the eligible concepts from this seven-key list");
    expect(readme).toContain(
      "percent display, percent label, provider selection, poll interval, request timeout, accounting detail, and wait-for-reset",
    );
    expect(readme).toContain("Workspace and project overrides are not import sources");
    expect(readme).toContain("Settings, import, and visibility changes write only");
    expect(readme).toContain("a workspace/project layer still wins for the same key");
    expect(readme).toContain("notes only meaningful overriding scopes");
    expect(readme).toContain("source files stay byte-for-byte untouched");
    expect(readme).toContain(
      "in the `plugins` list of your global OpenCode config (by default `~/.config/opencode/opencode.json(c)`)",
    );
    expect(readme).not.toContain(
      "in the `plugins` list of `~/.config/opencode/opencode.json(c)` or your project config",
    );
    expect(readme).toContain("embedded in this dashboard page");
    expect(readme).not.toContain("for the running dashboard");
    expect(manualInstall).toContain("wins over the global legacy `quota-toast.jsonc`");
    expect(manualInstall).toContain(
      "a project/workspace `quota-toast.jsonc` still wins for the same key",
    );
  });

  it("keeps copy-paste integrations independent of entry order", () => {
    const external = read("docs/readme/external-integration.md");

    expect(external).not.toContain("entries[0].percentRemaining");
    expect(external).toContain('select(.renderType == "percent"');
    expect(external.match(/renderType/g)?.length).toBeGreaterThanOrEqual(5);
    expect(external).toContain('status: "partial"');
    expect(external).toContain("Results were incomplete");
  });

  it("keeps surface formatters generic", () => {
    for (const path of [
      "src/lib/quota-command-format.ts",
      "src/lib/toast-format-grouped.ts",
      "src/lib/tui-sidebar-format.ts",
      "src/lib/tui-compact-format.ts",
    ]) {
      const formatter = read(path);
      expect(formatter).not.toContain("quota-providers");
      expect(formatter).not.toContain("quotaProviders");
      expect(formatter).not.toContain("customSources");
    }
  });
});
