import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

/** Every dist file that `entry` loads through relative `import` and `export ... from`. */
function reachableFrom(entry: string): string[] {
  const reached = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /\b(?:import|export)\b[^"';]*?["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      pending.push(resolve(dirname(file), match[1]));
    }
  }
  return [...reached].map((file) => relative(distDir, file)).sort();
}

/** The reached files whose source queries OpenCode's credential table. */
function filesQueryingCredentials(reached: string[]): string[] {
  return reached.filter((file) =>
    readFileSync(resolve(distDir, file), "utf8").includes("FROM credential"),
  );
}

describe("server plugin dist import graph", () => {
  // Inside OpenCode, logins come only through the plugin API. The terminal command's
  // read-only database reader must stay out of the server plugin.
  it("keeps the terminal command's database login reader out of the server plugin", () => {
    const entry = resolve(distDir, "index.js");
    expect(existsSync(entry)).toBe(true);

    const reached = reachableFrom(entry);

    expect(reached).toContain("plugin.js");
    expect(reached).not.toContain("lib/opencode-auth-sqlite.js");
    expect(reached).not.toContain("lib/cli-show.js");
    expect(reached).not.toContain("lib/cli-status.js");
    expect(filesQueryingCredentials(reached)).toEqual([]);
  });
});
