import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

function readMarkdownSection(document: string, heading: string): string {
  const lines = document.split("\n");
  let start = lines.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`Section not found: ${heading}`);
  start += 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

type ProviderLedgerRow = {
  provider: string;
  authSetup: string;
  dataFrom: string;
  reports: string;
};

function readVisibleCellText(cell: string): string {
  return cell.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function readPreConfiguredProviderSection(document: string): string {
  const headingIndex = document.search(
    /^#{2,3} (?:Pre-configured providers|Pre-configured American providers)$/m,
  );
  if (headingIndex === -1) throw new Error("Pre-configured provider section heading not found");

  const providerSection = document.slice(headingIndex);
  const customProvidersOffset = providerSection.search(/^#{2,3} Custom providers$/m);
  if (customProvidersOffset === -1) throw new Error("Custom provider section heading not found");

  return providerSection.slice(0, customProvidersOffset);
}

function readPreConfiguredProviderTables(document: string): ProviderLedgerRow[][] {
  const lines = readPreConfiguredProviderSection(document).split("\n");
  const tables: ProviderLedgerRow[][] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("| Provider")) continue;

    const rows: ProviderLedgerRow[] = [];
    index += 2;
    while (index < lines.length && lines[index].startsWith("|")) {
      const [provider, authSetup, dataFrom, reports] = lines[index]
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      rows.push({
        provider,
        authSetup: readVisibleCellText(authSetup),
        dataFrom,
        reports,
      });
      index += 1;
    }
    tables.push(rows);
  }

  return tables;
}

function readTierNeutralProviderTables(document: string): ProviderLedgerRow[][] {
  return readPreConfiguredProviderTables(document).map((table) =>
    table.map((row) => ({
      ...row,
      provider: row.provider === "xAI SuperGrok" ? "xAI" : row.provider,
    })),
  );
}

function markdownLinks(document: string): string[] {
  return Array.from(document.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)).map(
    (match) => match[1],
  );
}

function headingSlugs(document: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of document.split("\n")) {
    const explicit = /<a id="([^"]+)"><\/a>/.exec(line);
    if (explicit) slugs.add(explicit[1]);
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (!heading) continue;
    slugs.add(
      heading[1]
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9 _-]/g, "")
        .replace(/ /g, "-"),
    );
  }
  return slugs;
}

const PUBLIC_DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "docs/readme/configuration.md",
  "docs/readme/manual-install.md",
  "docs/readme/updating.md",
  "docs/readme/troubleshooting.md",
  "docs/readme/providers.md",
  "docs/readme/external-integration.md",
];

describe("README provider ledger", () => {
  const readme = read("README.md");
  const providerGuide = read("docs/readme/providers.md");

  it("keeps the README and provider guide ledgers consistent", () => {
    expect(readTierNeutralProviderTables(readme)).toEqual(
      readTierNeutralProviderTables(providerGuide),
    );
  });

  it("keeps the basic provider documentation structure", () => {
    for (const document of [readme, providerGuide]) {
      expect(document).toMatch(/^#.+Providers|^## Providers$/m);
      expect(document).toMatch(/^#{2,3} Custom providers$/m);
      expect(document).toContain("quotaProviders");
    }
  });
});

describe("dashboard-first public documentation", () => {
  const readme = read("README.md");

  it("presents the requested README sections in dashboard-first order", () => {
    const headings = [
      "Features",
      "Quick start",
      "Dashboard",
      "Providers",
      "Settings and privacy",
      "Installing and updating",
      "OpenCode and upstream compatibility",
      "Support",
      "Contributing",
      "Acknowledgements and license",
      "Contributors",
      "Star history",
    ];
    let previous = -1;
    for (const heading of headings) {
      const index = readme.indexOf(`## ${heading}\n`);
      expect(index, heading).toBeGreaterThan(previous);
      previous = index;
    }
    expect(readme).toContain("# OpenCode Quota GUI");
  });

  it("leads with the approved OpenCode plugin install and dashboard URL", () => {
    const quickStart = readMarkdownSection(readme, "Quick start");
    expect(quickStart).toContain("opencode plugin add opencode-quota-gui");
    expect(quickStart).toContain('"plugins": ["opencode-quota-gui"]');
    expect(quickStart).toContain("http://localhost:4144/quota");
    expect(quickStart).toContain("installs the configured npm plugin");
    expect(quickStart).not.toContain("npx opencode-quota-gui init");
  });

  it("documents loopback hosting, canonical settings, and upstream coexistence", () => {
    const dashboard = readMarkdownSection(readme, "Dashboard");
    expect(dashboard).toContain("127.0.0.1");
    expect(dashboard).toContain("does not listen on network interfaces");
    expect(dashboard).toContain("outside this guarantee");
    expect(dashboard).not.toContain("Nothing on your network can reach it");
    expect(dashboard).toContain("no cloud");
    expect(dashboard).toContain("native frontend");

    const settings = readMarkdownSection(readme, "Settings and privacy");
    expect(settings).toContain("~/.config/opencode/opencode-quota-gui/config.jsonc");
    expect(settings).toContain("only the canonical file");
    expect(settings).toContain("byte-for-byte");
    expect(settings).toContain("Settings → Visibility");

    const compatibility = readMarkdownSection(readme, "OpenCode and upstream compatibility");
    expect(compatibility).toContain("no TUI");
    expect(compatibility).toContain("terminal quota interface");
    expect(compatibility).toContain("maintenance only");
    expect(compatibility).toContain("@slkiser/opencode-quota");
    expect(compatibility).toContain("no dependency or conflict guard");
  });

  it("keeps the npm version and license badges and omits download and CI badges", () => {
    expect(readme).toContain("img.shields.io/npm/v/opencode-quota-gui");
    expect(readme).toContain("img.shields.io/badge/License-MIT-yellow.svg");
    expect(readme).not.toContain("img.shields.io/npm/dm/opencode-quota-gui");
    expect(readme).not.toContain("actions/workflows/ci.yml");
  });

  it("contains no removed terminal-product instructions", () => {
    for (const document of PUBLIC_DOCS) {
      const content = read(document);
      for (const removed of [
        "npx opencode-quota-gui show",
        "npx opencode-quota-gui status",
        "npx opencode-quota-gui provider add",
        "opencode-quota-gui show",
        "/quota_status",
        "/quota_announcements",
        "/pricing_refresh",
        "/tokens_",
        "tuiSidebarPanel",
        "tuiCompactStatus",
        "tuiPromptBar",
        "enableToast",
        "[OpenCode Quota report]",
        "End of OpenCode Quota report",
      ]) {
        expect(content, `${document}: ${removed}`).not.toContain(removed);
      }
    }
  });

  it("points Contributors and Star history at this repository only", () => {
    const contributors = readMarkdownSection(readme, "Contributors");
    expect(contributors).toContain("PVLPM/opencode-quota-gui");
    expect(contributors).not.toContain("slkiser/opencode-quota/graphs/contributors");

    const starHistory = readMarkdownSection(readme, "Star history");
    expect(starHistory).toContain("PVLPM/opencode-quota-gui");
    expect(starHistory).not.toContain("slkiser/opencode-quota&");
  });

  it("keeps every relative public docs link and anchor resolvable", () => {
    for (const document of PUBLIC_DOCS) {
      const source = read(document);
      for (const destination of markdownLinks(source)) {
        if (/^(?:https?:|mailto:)/.test(destination)) continue;
        const [path, fragment] = destination.split("#");
        const targetUrl =
          path === "" ? new URL(document, ROOT) : new URL(path, new URL(document, ROOT));
        expect(existsSync(fileURLToPath(targetUrl)), `${document} -> ${destination}`).toBe(true);
        if (fragment) {
          const targetDocument =
            path === ""
              ? document
              : fileURLToPath(targetUrl).slice(fileURLToPath(ROOT).length).replaceAll("\\", "/");
          expect(headingSlugs(read(targetDocument)), destination).toContain(fragment);
        }
      }
    }
  });

  it("does not reference retired shawnkiser image or branding hosts", () => {
    for (const document of PUBLIC_DOCS) {
      expect(read(document)).not.toContain("shawnkiser.com");
    }
  });

  it("retains MIT attribution without a continuation hero", () => {
    const acknowledgements = readMarkdownSection(readme, "Acknowledgements and license");
    expect(acknowledgements).toContain("MIT");
    expect(acknowledgements).toContain("https://github.com/slkiser/opencode-quota");
    expect(readme).not.toContain("independent continuation");
  });
});
