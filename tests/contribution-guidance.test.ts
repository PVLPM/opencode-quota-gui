import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readMarkdownSection } from "./helpers/markdown-document.js";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function headingIndex(document: string, heading: string): number {
  const index = document.split("\n").indexOf(`## ${heading}`);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("contribution guidance", () => {
  const prTemplate = read(".github/pull_request_template.md");
  const contributing = read("CONTRIBUTING.md");

  it("places dashboard evidence after OpenCode Validation and before Quality Checklist", () => {
    const openCodeValidation = headingIndex(prTemplate, "OpenCode Validation");
    const evidence = headingIndex(prTemplate, "Before-and-after evidence");
    const quality = headingIndex(prTemplate, "Quality Checklist");
    expect(openCodeValidation).toBeLessThan(evidence);
    expect(evidence).toBeLessThan(quality);
    expect(headingIndex(contributing, "Before-and-after screenshots (required)")).toBeLessThan(
      headingIndex(contributing, "PR checklist"),
    );
  });

  it("requires matching dashboard screenshots, redaction, and justified Not applicable", () => {
    const templateEvidence = readMarkdownSection(prTemplate, /^Before-and-after evidence$/);
    expect(templateEvidence).toContain("matching before-and-after screenshots");
    expect(templateEvidence).toContain("dashboard");
    expect(templateEvidence).toContain("Quota, Analytics, and Settings");
    expect(templateEvidence).toContain(
      "same configuration, model/provider, theme, and window size",
    );
    expect(templateEvidence).toMatch(
      /redact credentials, account identifiers, private paths, and other sensitive information/i,
    );
    expect(templateEvidence).toContain("`Not applicable`");
    expect(templateEvidence).toContain("explain briefly");
    expect(templateEvidence).toContain("Tests do not replace screenshot evidence");

    const contributingEvidence = readMarkdownSection(
      contributing,
      /^Before-and-after screenshots \(required\)$/,
    );
    expect(contributingEvidence).toContain("must include before-and-after screenshots");
    expect(contributingEvidence).toContain("dashboard");
    expect(contributingEvidence).toContain("same config, model, theme, and window size");
    expect(contributingEvidence).toContain("Quota, Analytics, and Settings");
    expect(contributingEvidence).toContain(
      "credentials, account identifiers, and private paths hidden",
    );
    expect(contributingEvidence).toContain("`Not applicable`");
    expect(contributingEvidence).toContain("Tests don't replace screenshots");

    expect(readMarkdownSection(contributing, /^PR checklist$/)).toContain(
      "Before-and-after dashboard screenshots and route results, or `Not applicable`",
    );
  });

  it("uses canonical pnpm verify and keeps production-version and focused-change requirements", () => {
    expect(prTemplate).toContain("I ran `pnpm verify`");
    expect(prTemplate).not.toContain("I ran `pnpm run typecheck`");
    expect(prTemplate).not.toContain("I ran `pnpm run build`");
    expect(prTemplate).not.toContain("I ran `pnpm test`");
    expect(prTemplate).toContain("Current production released OpenCode version tested:");
    expect(prTemplate).toContain("This change is focused and avoids unrelated behavior changes");
    expect(contributing).toContain("`pnpm verify` passes");
    expect(contributing).toContain("Tested on the current released OpenCode");
    expect(contributing).toContain("smallest safe fix");
  });

  it("keeps contribution boundaries aligned with the GUI-only product", () => {
    const rules = readMarkdownSection(contributing, /^Rules the code must keep$/);
    expect(rules).toContain("dashboard");
    expect(rules).toContain("does not register slash commands");
    expect(rules).toContain("no TUI");
    expect(rules).toContain("ctx.integration");
    expect(rules).toContain("tests/plugin.gui-only.test.ts");
    expect(rules).toContain("tests/gui.config-canonical.test.ts");
    expect(contributing).not.toContain("/quota_status");
    expect(contributing).not.toContain("four-surface");
  });
});
