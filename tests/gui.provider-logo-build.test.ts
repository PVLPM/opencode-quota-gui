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

interface Manifest {
  logoCount: number;
  logos: Record<string, { url: string; bytes: number; sha256: string }>;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

describe("packaged provider logo assets", () => {
  it("copies exactly the vendored catalog plus the local generic fallback", () => {
    if (!existsSync(outputLogoDir)) {
      throw new Error('Run "pnpm run build" first: dist/ui/assets/providers is missing.');
    }
    const expected = [...Object.keys(manifest.logos), "generic"].map((id) => `${id}.svg`).sort();
    const actual = readdirSync(outputLogoDir)
      .filter((file) => file.endsWith(".svg"))
      .sort();
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(manifest.logoCount + 1);
    for (const [id, entry] of Object.entries(manifest.logos)) {
      const file = path.join(outputLogoDir, `${id}.svg`);
      expect(existsSync(file), `missing packaged ${file}`).toBe(true);
      expect(readFileSync(file).length).toBe(entry.bytes);
      expect(entry.url).toBe(`/assets/providers/${id}.svg`);
    }
  });

  it("ships the upstream MIT notice and the local brand-rights disclaimer", () => {
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
    expect(output).toContain("223 provider logos");
  });
});
