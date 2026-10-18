import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkEmittedFiles,
  checkGraphMetadata,
  checkIndexHtml,
  checkModuleGraph,
  checkNoSourceMaps,
  checkPrivatePaths,
  checkStylesheetUrls,
  normalizeModuleId,
  UI_GRAPH_METADATA_PATH,
  UI_OUT_DIR,
  UI_PACKAGED_ASSET_EXTENSIONS,
} from "../scripts/lib/ui-bundle-checks.mjs";

/**
 * Emitted bundle evidence (design spec §11.1; R5, R6, R37, R39).
 *
 * The checks read Vite's own module graph and the real emitted files, so they
 * prove the browser bundle imports no Node built-in, no network module, and no
 * server-side core or provider module, that every served path is a same-origin
 * asset, and that nothing shipped or cached carries a private filesystem root or
 * a source-map reference. The verifier itself is exercised against doctored
 * input first, so a passing run cannot be vacuous.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, UI_OUT_DIR);
const metadataPath = path.join(repoRoot, UI_GRAPH_METADATA_PATH);

interface GraphMetadata {
  outDir: string;
  htmlFile: string;
  base: string;
  modules: string[];
  emittedFiles: string[];
  entryChunks: string[];
}

function realMetadata(): GraphMetadata {
  if (!existsSync(metadataPath)) {
    throw new Error(
      `Run "pnpm run build" first: ${UI_GRAPH_METADATA_PATH} does not exist. The bundle test checks real build output.`,
    );
  }
  return JSON.parse(readFileSync(metadataPath, "utf8")) as GraphMetadata;
}

function listFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(dir, relative));
    else files.push(relative);
  }
  return files;
}

describe("bundle verifier is not vacuous", () => {
  const cleanModules = [
    "src/ui/main.tsx",
    "src/contracts/ranges.ts",
    "node_modules/@opencode/ui/src/actions/button/button.tsx",
    "node_modules/.pnpm/solid-js@1.9.12/node_modules/solid-js/dist/solid.js",
  ];

  it("accepts a graph that stays inside the browser-side roots", () => {
    expect(checkModuleGraph(cleanModules)).toEqual([]);
  });

  it("rejects Node built-ins, network modules, server modules, and foreign runtimes", () => {
    expect(checkModuleGraph([...cleanModules, "node:fs"])).toHaveLength(1);
    expect(checkModuleGraph([...cleanModules, "https://cdn.example.com/lib.js"])).toHaveLength(1);
    expect(checkModuleGraph([...cleanModules, "src/lib/quota-providers.ts"])).toHaveLength(2);
    expect(checkModuleGraph([...cleanModules, "src/gui/server.ts"])).toHaveLength(2);
    expect(checkModuleGraph([...cleanModules, "node_modules/react/jsx-runtime.js"])).toHaveLength(
      1,
    );
    expect(checkModuleGraph([...cleanModules, "C:/absolute/path.ts"])).toHaveLength(1);
  });

  it("requires the public UI library and our own sources in the graph", () => {
    expect(checkModuleGraph(["src/contracts/ranges.ts"])).toHaveLength(2);
    expect(checkModuleGraph(["node_modules/solid-js/dist/solid.js"])).toHaveLength(2);
    expect(checkModuleGraph([])).toHaveLength(1);
  });

  it("rejects emitted files outside dist/ui or the packaged allowlist", () => {
    const good = ["index.html", "assets/index-abc.js", "assets/index-abc.css", "assets/font.woff2"];
    expect(checkEmittedFiles(good)).toEqual([]);
    expect(checkEmittedFiles([...good, "assets/index-abc.js.map"])).toHaveLength(1);
    expect(checkEmittedFiles([...good, "assets/../secret.js"])).toHaveLength(1);
    expect(checkEmittedFiles([...good, "assets/server.ts"])).toHaveLength(1);
    expect(checkEmittedFiles(good.filter((file) => file !== "index.html"))).toHaveLength(1);
  });

  it("rejects inline scripts, import maps, and off-origin references", () => {
    const good =
      '<div id="root"></div><script type="module" src="/assets/index.js"></script><link rel="stylesheet" href="/assets/index.css">';
    expect(checkIndexHtml(good)).toEqual([]);
    expect(checkIndexHtml('<div id="root"></div><script>window.x = 1</script>')).toHaveLength(1);
    expect(
      checkIndexHtml('<div id="root"></div><script type="importmap">{}</script>'),
    ).toHaveLength(2);
    expect(
      checkIndexHtml('<div id="root"></div><script src="https://cdn.example.com/x.js"></script>'),
    ).toHaveLength(1);
    expect(
      checkIndexHtml('<div id="root"></div><script src="//cdn.example.com/x.js"></script>'),
    ).toHaveLength(1);
    expect(checkIndexHtml('<div id="app"></div>')).toHaveLength(1);
  });

  it("rejects stylesheets that fetch fonts from anywhere but this origin", () => {
    expect(checkStylesheetUrls("@font-face{src:url(/assets/font.woff2)}")).toEqual([]);
    expect(checkStylesheetUrls("@font-face{src:url(data:font/woff2;base64,AAAA)}")).toEqual([]);
    expect(
      checkStylesheetUrls("@font-face{src:url(https://fonts.example.com/font.woff2)}"),
    ).toHaveLength(1);
  });

  it("rejects malformed graph metadata", () => {
    expect(
      checkGraphMetadata({
        outDir: UI_OUT_DIR,
        htmlFile: "index.html",
        base: "/",
        modules: [],
        emittedFiles: [],
        entryChunks: ["assets/index.js"],
      }),
    ).toEqual([]);
    expect(checkGraphMetadata(undefined)).toHaveLength(1);
    expect(
      checkGraphMetadata({ outDir: "dist/other", htmlFile: "index.html", base: "/" }),
    ).toHaveLength(4);
  });
});

describe("the real emitted bundle", () => {
  it("records a graph and a file list that satisfy every rule", () => {
    const metadata = realMetadata();
    expect(checkGraphMetadata(metadata)).toEqual([]);
    expect(checkModuleGraph(metadata.modules)).toEqual([]);
    expect(checkEmittedFiles(metadata.emittedFiles)).toEqual([]);
    expect(metadata.entryChunks.length).toBeGreaterThan(0);
  });

  it("serves only same-origin assets and no inline script", () => {
    const html = readFileSync(path.join(outDir, "index.html"), "utf8");
    expect(checkIndexHtml(html)).toEqual([]);
    const stylesheets = realMetadata().emittedFiles.filter((file) => file.endsWith(".css"));
    expect(stylesheets.length).toBeGreaterThan(0);
    for (const stylesheet of stylesheets) {
      expect(checkStylesheetUrls(readFileSync(path.join(outDir, stylesheet), "utf8"))).toEqual([]);
    }
  });

  it("keeps every emitted file inside the allowlist, fonts included", () => {
    const onDisk = listFiles(outDir).sort();
    expect(onDisk).toEqual([...realMetadata().emittedFiles].sort());
    const extensions = new Set(onDisk.map((file) => path.extname(file).toLowerCase()));
    for (const extension of extensions) expect(UI_PACKAGED_ASSET_EXTENSIONS).toContain(extension);
  });

  it("ships the public library in the browser bundle", () => {
    const modules = realMetadata().modules;
    expect(modules.some((moduleId) => moduleId.startsWith("@opencode/ui"))).toBe(false);
    expect(modules.some((moduleId) => moduleId.startsWith("node_modules/@opencode/ui/"))).toBe(
      true,
    );
    // The library's own CSS is bundled, so its component styles travel with the build.
    const css = realMetadata()
      .emittedFiles.filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(path.join(outDir, file), "utf8"))
      .join("\n");
    expect(css).toContain("button-v2");
  });

  it("runs the verifier script end to end", () => {
    const output = execFileSync(process.execPath, ["scripts/verify-ui-bundle.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(output).toContain("UI bundle verified");
    expect(output).toContain("Graph evidence");
    expect(output).toContain("Privacy: no source maps");
  });
});

describe("privacy of the build evidence", () => {
  const windowsRoot = "C:\\Users\\someone\\opencode-projects\\opencode-quota-gui";

  it("never emits an absolute, home, or store path for a module id", () => {
    // The normal in-repo cases stay readable and relative.
    expect(normalizeModuleId(`${windowsRoot}\\src\\ui\\main.tsx`, windowsRoot)).toBe(
      "src/ui/main.tsx",
    );
    expect(
      normalizeModuleId(
        `${windowsRoot}\\node_modules\\.pnpm\\@kobalte+core@0.13.13_solid-js@1.9.12\\node_modules\\@kobalte\\core\\dist\\chunk\\X.jsx`,
        windowsRoot,
      ),
    ).toBe("node_modules/@kobalte/core/dist/chunk/X.jsx");
    expect(normalizeModuleId("src/ui/app.tsx?v=1", windowsRoot)).toBe("src/ui/app.tsx");

    // Anything outside the repository collapses to a package-relative id: no
    // drive letter, no home directory, no pnpm store hash.
    const foreign = [
      "C:\\Users\\someone\\.pnpm-store\\v3\\files\\aa\\@opencode\\ui\\src\\index.tsx",
      "D:\\builds\\cache\\node_modules\\@kobalte\\utils\\dist\\x.js",
      "/home/someone/projects/app/node_modules/@opencode/ui/src/button.tsx",
      "/Users/someone/.pnpm-store/v3/files/zz/@kobalte/core/dist/y.jsx",
    ];
    for (const id of foreign) {
      const normalized = normalizeModuleId(id, windowsRoot);
      expect(checkPrivatePaths([{ fileName: "module-id", text: normalized }])).toEqual([]);
      expect(normalized.startsWith(".")).toBe(false);
      expect(normalized).not.toMatch(/^[A-Za-z]:[\\/]/);
      expect(normalized).toContain("external/");
      expect(normalized).toContain("@");
    }
    // A path with no package directory at all still leaks nothing.
    expect(normalizeModuleId("/opt/private/build/tmp/thing.js", windowsRoot)).toBe(
      "external/tmp/thing.js",
    );
  });

  it("recognizes the private paths that must never ship, and ignores URL schemes", () => {
    const find = (text: string) => checkPrivatePaths([{ fileName: "asset.js", text }]);
    expect(find("const a = 1;")).toEqual([]);
    // W3C namespaces and ordinary URLs are not filesystem roots.
    expect(find('xmlns="http://www.w3.org/2000/svg"')).toEqual([]);
    expect(find('xlink:"https://www.w3.org/1999/xlink"')).toEqual([]);
    expect(find("C:\\Users\\someone\\secret.ts")).toHaveLength(1);
    expect(find("C:/Users/someone/secret.ts")).toHaveLength(1);
    expect(find("file:///C:/Users/someone/out.js")).toHaveLength(2);
    expect(find("/home/someone/secret.ts")).toHaveLength(1);
    expect(find("/Users/someone/secret.ts")).toHaveLength(1);
    expect(
      find("node_modules/.pnpm/@kobalte+core@0.13.13/node_modules/@kobalte/core/x.jsx"),
    ).toHaveLength(1);
    expect(find("//# sourceMappingURL=index.js.map")).toHaveLength(1);
  });

  it("refuses to emit a source map", () => {
    expect(checkNoSourceMaps(["index.html", "assets/index-a.js", "assets/index-a.css"])).toEqual(
      [],
    );
    expect(checkNoSourceMaps(["assets/index-a.js.map"])).toHaveLength(1);
  });

  it("keeps the module-graph evidence out of the packaged and served output", () => {
    expect(UI_GRAPH_METADATA_PATH.startsWith("dist/")).toBe(false);
    expect(UI_GRAPH_METADATA_PATH.startsWith("node_modules/")).toBe(true);
    expect(existsSync(path.join(repoRoot, "dist/ui-graph.json"))).toBe(false);
    expect(listFiles(path.join(repoRoot, UI_OUT_DIR)).some((file) => file.endsWith(".map"))).toBe(
      false,
    );
  });

  it("ships no private path and no source-map reference with the real bundle", () => {
    const metadata = realMetadata();
    expect(
      checkPrivatePaths([{ fileName: UI_GRAPH_METADATA_PATH, text: JSON.stringify(metadata) }]),
    ).toEqual([]);
    for (const moduleId of metadata.modules) {
      expect(moduleId).toMatch(/^(src\/|node_modules\/)/);
    }
    expect(checkNoSourceMaps(metadata.emittedFiles)).toEqual([]);

    for (const fileName of metadata.emittedFiles) {
      if (!/\.(html|css|js|svg|json)$/.test(fileName)) continue;
      expect(
        checkPrivatePaths([{ fileName, text: readFileSync(path.join(outDir, fileName), "utf8") }]),
      ).toEqual([]);
    }
  });
});
