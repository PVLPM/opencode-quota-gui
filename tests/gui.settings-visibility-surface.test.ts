import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Settings → Visibility card tone (narrow visual correction).
 *
 * A provider card hidden through the eye toggle is the inactive card in this
 * list. It must recede to the surrounding frame tone instead of gaining the
 * lighter raised surface, so hidden cards read as set back rather than
 * elevated. This is tone only: active cards keep their surface and the card
 * layout rules (including the issue #9 row composition) are untouched.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");

/** First exact top-level rule body for a selector; an absent selector is empty. */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "m").exec(source);
  return match?.[1] ?? "";
}

/** Declared properties of a rule body, keyed by property name. */
function declarations(body: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const part of body.split(";")) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const property = part.slice(0, separator).trim();
    if (property === "") continue;
    entries.set(property, part.slice(separator + 1).trim());
  }
  return entries;
}

describe("Settings Visibility card tone", () => {
  it("recedes a hidden provider card to the frame tone", () => {
    const hidden = ruleBody(styles, '.qg-vis-provider[data-hidden="true"]');

    expect(hidden).not.toBe("");
    expect(declarations(hidden).get("background")).toBe("var(--qg-frame)");
    expect(hidden).not.toContain("--qg-surface-raised");
  });

  it("keeps an active provider card on its existing surface", () => {
    const active = ruleBody(styles, ".qg-vis-provider");

    expect(declarations(active).get("background")).toBe("var(--qg-surface)");
  });

  it("changes tone only, leaving the card layout contract to the base rule", () => {
    const hidden = ruleBody(styles, '.qg-vis-provider[data-hidden="true"]');

    expect([...declarations(hidden).keys()]).toEqual(["background"]);
    // The base card still owns the box and the rows still own their grid.
    expect(declarations(ruleBody(styles, ".qg-vis-provider")).get("min-width")).toBe("0");
    expect(
      declarations(ruleBody(styles, ".qg-vis-provider__head")).get("grid-template-columns"),
    ).toBe("20px minmax(0, 1fr) 28px");
    expect(declarations(ruleBody(styles, ".qg-vis-row")).get("grid-template-columns")).toBe(
      "20px minmax(0, 1fr) 28px",
    );
  });
});
