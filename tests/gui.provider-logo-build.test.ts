import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Packaged evidence for the provider logos. Run `pnpm run build` first: this
 * checks the real dist tree that ships, not a source-only assumption, and then
 * invokes the release-content verifier so the notice and logo count are proven
 * in the exact npm manifest.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceLogoDir = path.join(repoRoot, "src/ui/assets/provider-logos");
const outputLogoDir = path.join(repoRoot, "dist/ui/assets/providers");
const noticeDir = path.join(repoRoot, "dist/provider-logos");
const manifestPath = path.join(sourceLogoDir, "manifest.json");
const localOverridesPath = path.join(sourceLogoDir, "local-overrides.json");

interface Manifest {
  logoCount: number;
  logos: Record<string, { url: string; bytes: number; sha256: string }>;
}

interface LocalOverrides {
  repository: string;
  commit: string;
  license: string;
  logos: Record<string, { url: string; bytes: number; sha256: string }>;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const localOverrides = JSON.parse(readFileSync(localOverridesPath, "utf8")) as LocalOverrides;

describe("packaged provider logo assets", () => {
  it("copies the pinned catalog, local overrides and generic fallback", () => {
    if (!existsSync(outputLogoDir)) {
      throw new Error('Run "pnpm run build" first: dist/ui/assets/providers is missing.');
    }
    const expected = [
      ...Object.keys(manifest.logos),
      ...Object.keys(localOverrides.logos),
      "generic",
    ]
      .map((id) => `${id}.svg`)
      .sort();
    const actual = readdirSync(outputLogoDir)
      .filter((file) => file.endsWith(".svg"))
      .sort();
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(manifest.logoCount + Object.keys(localOverrides.logos).length + 1);
    for (const [id, entry] of Object.entries(manifest.logos)) {
      const file = path.join(outputLogoDir, `${id}.svg`);
      expect(existsSync(file), `missing packaged ${file}`).toBe(true);
      expect(readFileSync(file).length).toBe(entry.bytes);
      expect(entry.url).toBe(`/assets/providers/${id}.svg`);
    }
    for (const [id, entry] of Object.entries(localOverrides.logos)) {
      const file = path.join(outputLogoDir, `${id}.svg`);
      expect(existsSync(file), `missing packaged ${file}`).toBe(true);
      expect(readFileSync(file).length).toBe(entry.bytes);
      expect(entry.url).toBe(`/assets/providers/${id}.svg`);
    }
  });

  it("ships the upstream MIT notice, OpenCode artwork license, and brand disclaimer", () => {
    if (!existsSync(noticeDir)) {
      throw new Error('Run "pnpm run build" first: dist/provider-logos is missing.');
    }
    const license = readFileSync(path.join(noticeDir, "UPSTREAM-MIT.txt"), "utf8");
    const notice = readFileSync(path.join(noticeDir, "NOTICE.md"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2025 models.dev");
    expect(notice).toContain("30a8b13a5a5507979ddbf8d339c7746cf7e4f442");
    expect(notice).toMatch(/trademark|brand rights/iu);
    expect(notice).toMatch(/no affiliation|not affiliated/iu);
    expect(notice).toMatch(/opencode-go/iu);
    expect(notice).toMatch(/trailing|whitespace/iu);

    const opencodeLicense = readFileSync(path.join(noticeDir, "OPENCODE-MIT.txt"), "utf8");
    const opencodeNotice = readFileSync(path.join(noticeDir, "OPENCODE-NOTICE.md"), "utf8");
    expect(opencodeLicense).toContain("MIT License");
    expect(opencodeLicense).toContain("Copyright (c) 2025 opencode");
    expect(opencodeNotice).toContain(localOverrides.repository);
    expect(opencodeNotice).toContain(localOverrides.commit);
    expect(opencodeNotice).toContain("packages/ui/src/components/provider-icons/sprite.svg");
    expect(opencodeNotice).toContain("opencode-go");
  });

  it("passes the release-content verifier with the logos and notices in the manifest", () => {
    if (!existsSync(outputLogoDir) || !existsSync(noticeDir)) {
      throw new Error('Run "pnpm run build" first: packaged provider assets are missing.');
    }
    const output = execFileSync(process.execPath, ["scripts/verify-package-contents.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(output).toContain("npm contents verified");
    expect(output).toContain("224 provider logos");
  });
});
