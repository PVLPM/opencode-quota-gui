import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Layer and import-graph rules (design spec §4.1, §11.1; R5, R6, R37).
 *
 * The browser ships from `src/ui`, which may reach `src/contracts` and the
 * public UI library (through one wrapper) and nothing else: no Node built-in, no
 * core or provider module from `src/lib`, and no server module from `src/gui`.
 * The server-side layer never imports the browser layer back.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listFiles(dir: string, prefix = ""): string[] {
  const absolute = path.join(repoRoot, dir);
  const entries = readdirSync(absolute, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(path.join(dir, entry.name), relative));
      continue;
    }
    files.push(relative);
  }
  return files;
}

/**
 * Every import specifier in a source file: static, re-export, side-effect, and
 * dynamic. The patterns anchor on the statement keyword and use the closing
 * quote of a real module string, so an identifier or a string that merely
 * contains the word "from" is never mistaken for an import.
 */
function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [
    /(?:^|\n)\s*(?:import|export)\b[^"'`]*?\bfrom\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.add(match[1] ?? "");
      match = pattern.exec(source);
    }
  }
  return [...specifiers];
}

function sourceFiles(dir: string): { file: string; specifiers: string[] }[] {
  return listFiles(dir)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .map((file) => ({
      file: `${dir}/${file}`.replace(/\\/g, "/"),
      specifiers: importSpecifiers(readFileSync(path.join(repoRoot, dir, file), "utf8")),
    }));
}

const contracts = sourceFiles("src/contracts");
const ui = sourceFiles("src/ui");

describe("contract layer import rules", () => {
  it("has contract sources to check", () => {
    expect(contracts.map((entry) => entry.file).sort()).toEqual([
      "src/contracts/analytics-entity.ts",
      "src/contracts/analytics-temporal.ts",
      "src/contracts/build-identity.ts",
      "src/contracts/card-order.ts",
      "src/contracts/collision-safe-key.ts",
      "src/contracts/dashboard.ts",
      "src/contracts/guards.ts",
      "src/contracts/identity.ts",
      "src/contracts/openai-quota.ts",
      "src/contracts/ranges.ts",
      "src/contracts/settings.ts",
      "src/contracts/temporal.ts",
      "src/contracts/time-zone.ts",
    ]);
  });

  it("keeps the contracts browser-safe: relative imports only", () => {
    const violations: string[] = [];
    for (const { file, specifiers } of contracts) {
      for (const specifier of specifiers) {
        if (!specifier.startsWith(".")) violations.push(`${file} → ${specifier}`);
        if (/^node:/.test(specifier)) violations.push(`${file} → ${specifier} (Node built-in)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("never imports the server, the browser layer, or core from the contracts", () => {
    const violations: string[] = [];
    for (const { file, specifiers } of contracts) {
      for (const specifier of specifiers) {
        if (/\/(lib|gui|ui)\//.test(specifier)) violations.push(`${file} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("browser layer import rules", () => {
  it("imports only solid-js, the contracts, the wrapper, and its own modules", () => {
    const allowedPackage = (specifier: string): boolean =>
      specifier === "solid-js" || specifier.startsWith("solid-js/");
    const violations: string[] = [];
    for (const { file, specifiers } of ui) {
      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) {
          if (specifier.includes("opencode-ui")) continue;
          const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(file), specifier),
          );
          const allowed =
            resolved.startsWith("src/ui/") ||
            resolved.startsWith("src/contracts/") ||
            resolved.startsWith("node_modules");
          if (!allowed) violations.push(`${file} → ${specifier}`);
          continue;
        }
        if (allowedPackage(specifier)) continue;
        if (!/^@opencode\/ui\//.test(specifier)) violations.push(`${file} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps Node built-ins, core, provider, and server modules out of the browser layer", () => {
    const violations: string[] = [];
    for (const { file, specifiers } of ui) {
      for (const specifier of specifiers) {
        if (/^node:/.test(specifier)) violations.push(`${file} → ${specifier}`);
        if (/^\.\.\/(lib|gui)\//.test(specifier)) violations.push(`${file} → ${specifier}`);
        if (/^\.\.\/\.\.\/(lib|gui)\//.test(specifier)) violations.push(`${file} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("imports the public library from exactly one wrapper file", () => {
    const importers = ui
      .filter(({ specifiers }) =>
        specifiers.some((specifier) => /^@opencode\/ui\//.test(specifier)),
      )
      .map(({ file }) => file);
    expect(importers).toEqual(["src/ui/opencode-ui.ts"]);
  });

  it("does not import the browser layer from the server layer", () => {
    let server: { file: string; specifiers: string[] }[] = [];
    try {
      server = [...sourceFiles("src/gui")];
    } catch {
      server = [];
    }
    const violations = server.flatMap(({ file, specifiers }) =>
      specifiers
        .filter((specifier) => /\/ui(\/|$)/.test(specifier))
        .map((specifier) => `${file} → ${specifier}`),
    );
    expect(violations).toEqual([]);
  });
});

describe("the two TypeScript projects stay separate", () => {
  const backend = JSON.parse(readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
    exclude: string[];
  };
  const browser = JSON.parse(readFileSync(path.join(repoRoot, "tsconfig.ui.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };

  it("keeps the browser sources out of the backend project, changing nothing else", () => {
    expect(backend.exclude).toEqual(["node_modules", "dist", "src/ui"]);
    expect(backend.include).toEqual(["src/**/*"]);
    // The backend keeps the OpenTUI pragma and the Node types.
    expect(backend.compilerOptions.jsxImportSource).toBe("@opentui/solid");
    expect(backend.compilerOptions.types).toEqual(["node"]);
  });

  it("type-checks the browser UI against DOM types and the Solid JSX runtime only", () => {
    expect(browser.include).toEqual(["src/ui/**/*", "src/contracts/**/*"]);
    expect(browser.compilerOptions.jsxImportSource).toBe("solid-js");
    expect(browser.compilerOptions.jsx).toBe("preserve");
    expect(browser.compilerOptions.lib).toEqual(["ES2022", "DOM", "DOM.Iterable"]);
    expect(browser.compilerOptions.types).toEqual([]);
    expect(browser.compilerOptions.noEmit).toBe(true);
    expect(browser.compilerOptions.skipLibCheck).toBe(true);
  });
});
