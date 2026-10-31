import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";

/**
 * Public UI library adoption (design spec §11.1; R36).
 *
 * One wrapper file imports `@opencode/ui`, the pins are exact, the three start
 * subpaths are the ones actually shipped, the Solid peer the package needs is
 * satisfied by the version already in the tree, and no second UI library or the
 * private `gui-extensions` integration creeps in.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WrapperPath = "src/ui/opencode-ui.ts";
/**
 * Statically imported subpaths. The browser-only popover is loaded through the
 * package wildcard and is asserted separately below.
 */
const START_SUBPATHS = [
  "/button",
  "/text-input",
  "/styles",
  "/styles/tokens",
  "/icon",
  "/tooltip",
  "/switch",
  "/segmented-control",
];

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as Record<
    string,
    unknown
  >;
}

const packageJson = readJson("package.json");
const devDependencies = (packageJson.devDependencies ?? {}) as Record<string, string>;
const dependencies = (packageJson.dependencies ?? {}) as Record<string, string>;
const wrapperSource = readFileSync(path.join(repoRoot, WrapperPath), "utf8");
const libraryManifest = readJson("node_modules/@opencode/ui/package.json");
const solidManifest = readJson("node_modules/solid-js/package.json");

function librarySpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [
    /(?:^|\n)\s*(?:import|export)\b[^"'`]*?\bfrom\s*["'](@opencode\/ui[^"']*)["']/g,
    /(?:^|\n)\s*import\s*["'](@opencode\/ui[^"']*)["']/g,
  ]) {
    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.add(match[1] ?? "");
      match = pattern.exec(source);
    }
  }
  return [...specifiers];
}

describe("public UI library adoption", () => {
  it("compiles the JSX shipped by the public segmented control's installed motion dependency", () => {
    const source = "node_modules/@kitlangton/solid-motion/dist/source/motion/index.jsx";
    expect(SOLID_JSX_SOURCES.some((pattern) => pattern.test(source))).toBe(true);
    expect(SOLID_JSX_SOURCES.some((pattern) => pattern.test("src/gui/server.ts"))).toBe(false);
  });
  it("pins the library, its peer, and the build tooling to exact versions", () => {
    expect(devDependencies["@opencode/ui"]).toBe("2.0.32");
    expect(devDependencies["@solidjs/meta"]).toBe("0.29.4");
    expect(devDependencies.vite).toBe("8.3.4");
    expect(devDependencies["vite-plugin-solid"]).toBe("2.11.14");
    // The UI is a build input: it is bundled into dist/ui, never a runtime dependency.
    expect(dependencies["@opencode/ui"]).toBeUndefined();
    expect(dependencies["@solidjs/meta"]).toBeUndefined();
  });

  it("installs exactly the pinned versions", () => {
    expect(libraryManifest.version).toBe("2.0.32");
    expect(readJson("node_modules/vite/package.json").version).toBe("8.3.4");
    expect(readJson("node_modules/vite-plugin-solid/package.json").version).toBe("2.11.14");
    expect(readJson("node_modules/@solidjs/meta/package.json").version).toBe("0.29.4");
  });

  it("satisfies the library's peers with the versions already required", () => {
    const peers = libraryManifest.peerDependencies as Record<string, string>;
    expect(peers["solid-js"]).toBe("^1.9.8");
    expect(peers["@solidjs/meta"]).toBe("^0.29.0");
    const solidVersion = String(solidManifest.version);
    expect(solidVersion).toMatch(/^1\.9\./);
    expect(Number(solidVersion.split(".")[1])).toBeGreaterThanOrEqual(9);
    // 0.29.4 satisfies ^0.29.0 without loosening the pin.
    expect(devDependencies["@solidjs/meta"]?.startsWith("0.29.")).toBe(true);
    expect(peers["@solidjs/meta"]?.startsWith("^0.29.")).toBe(true);
  });

  it("imports the library statically from one wrapper and only the start subpaths", () => {
    expect(librarySpecifiers(wrapperSource).sort()).toEqual(
      START_SUBPATHS.map((subpath) => `@opencode/ui${subpath}`).sort(),
    );
    expect(wrapperSource).toContain('from "@opencode/ui/button"');
    expect(wrapperSource).toContain('from "@opencode/ui/text-input"');
    expect(wrapperSource).toContain('import "@opencode/ui/styles"');
  });

  it("loads the popover through the wrapper only when a browser mounts it", () => {
    expect(wrapperSource).toContain('import("@opencode/ui/popover")');
    expect(wrapperSource).not.toMatch(/from\s+["']@opencode\/ui\/popover["']/);
    const exportsMap = libraryManifest.exports as Record<string, unknown>;
    expect(exportsMap["./*"]).toBeDefined();
    expect(() =>
      readFileSync(path.join(repoRoot, "node_modules/@opencode/ui/src/components/popover.tsx")),
    ).not.toThrow();
  });

  it("exports exactly the subpaths the wrapper relies on, as source the compiler can read", () => {
    const exportsMap = libraryManifest.exports as Record<string, unknown>;
    for (const subpath of START_SUBPATHS) {
      expect(exportsMap[`.${subpath}`], `missing export ${subpath}`).toBeDefined();
    }
    const button = exportsMap["./button"] as { types: string; import: string };
    const textInput = exportsMap["./text-input"] as { types: string; import: string };
    expect(button.import.endsWith(".tsx")).toBe(true);
    expect(textInput.import.endsWith(".tsx")).toBe(true);
    expect(typeof exportsMap["./styles"]).toBe("string");
    expect(String(exportsMap["./styles"]).endsWith(".css")).toBe(true);
    for (const relativePath of [
      button.import,
      button.types,
      textInput.import,
      textInput.types,
      String(exportsMap["./styles"]),
    ]) {
      expect(() =>
        readFileSync(path.join(repoRoot, "node_modules/@opencode/ui", relativePath)),
      ).not.toThrow();
    }
  });

  it("never reaches for the private GUI integration and adds no second UI library", () => {
    for (const [name, version] of [
      ...Object.entries(dependencies),
      ...Object.entries(devDependencies),
    ]) {
      expect(name).not.toContain("gui-extensions");
      expect(version).not.toContain("gui-extensions");
    }
    for (const forbidden of [
      "daisyui",
      "tailwindcss",
      "@kobalte/core",
      "@radix-ui/react",
      "react",
    ]) {
      expect(dependencies[forbidden], `dependency ${forbidden}`).toBeUndefined();
      expect(devDependencies[forbidden], `devDependency ${forbidden}`).toBeUndefined();
    }
    expect(wrapperSource).not.toContain("gui-extensions");
  });
});
