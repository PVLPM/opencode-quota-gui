import path from "node:path";

/**
 * Bundle evidence checks for the browser-only UI build (design spec §11.1).
 *
 * These are graph and path checks, never string bans: the module graph comes
 * from Vite's own `generateBundle` output, the served paths come from the
 * emitted file list, and the HTML/CSS checks read attribute values and `url()`
 * tokens rather than scanning for arbitrary literals such as an SVG `xmlns` or a
 * library-internal URL.
 */

export const UI_OUT_DIR = "dist/ui";

/**
 * Build-only evidence, written into the git-ignored dependency cache rather than
 * into `dist/`: module ids and emitted file names are build internals, and
 * anything under `dist/` is both packaged for release and reachable by tooling
 * that maps filesystem paths. Keeping the metadata out of the artifact means the
 * privacy question never arises, and every id is normalized anyway (see
 * `normalizeModuleId`) so the file is portable between machines.
 */
export const UI_GRAPH_METADATA_PATH = "node_modules/.cache/opencode-quota-gui/ui-graph.json";

/**
 * Local packaged-asset allowlist (spec §9's starting set plus the font formats
 * the real `@opencode/ui` stylesheet emits). Kept here so the build, the
 * verifier, and the package-content check all read one list.
 */
export const UI_PACKAGED_ASSET_EXTENSIONS = [
  ".html",
  ".css",
  ".js",
  ".svg",
  ".woff2",
  ".woff",
  ".ttf",
];

/** Runtimes that must never appear in a Solid dashboard bundle. */
const FOREIGN_RUNTIMES = ["react", "react-dom", "preact", "vue", "svelte", "angular"];

/**
 * Normalizes a module id to a machine-independent, privacy-safe identifier.
 *
 * Three things are removed or replaced, so no emitted evidence can carry a
 * private filesystem root:
 *
 * - pnpm's store directory, which carries a peer-set hash
 *   (`node_modules/.pnpm/<pkg>@<version>_<hash>/node_modules/`), collapses to a
 *   plain `node_modules/<pkg>/...` path;
 * - anything outside the repository — a global store, a different drive, a home
 *   directory — collapses to a package-relative identifier (or, if no package
 *   directory can be found, to a bare `external/<file>`), never to an absolute
 *   path, a drive-letter root, or a user-home segment.
 */
export function normalizeModuleId(id, repoRoot) {
  const slashed = String(id).split("?")[0].split("\\").join("/");
  const absolute = path.isAbsolute(slashed) ? slashed : path.resolve(repoRoot, slashed);
  const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
  const inRepository = relative !== "" && !relative.startsWith("../") && !path.isAbsolute(relative);
  if (inRepository) return stripStorePrefix(relative);

  // Outside the repository: keep only the trailing `@scope/name/...` (or the
  // file itself), so the evidence still names the package without naming a
  // location on this machine.
  const unscoped = slashed.replace(/^[A-Za-z]:/, "");
  const scopeIndex = unscoped.lastIndexOf("/@");
  if (scopeIndex !== -1) {
    const scoped = unscoped.slice(scopeIndex + 1).replace(/^([^/]+\/[^/]+)(?:\/.*)?$/, "$1");
    return `external/${scoped}`;
  }
  const segments = unscoped.split("/").filter((segment) => segment.length > 0);
  const tail = segments.slice(-2).join("/");
  return `external/${tail === "" ? "unknown" : tail}`;
}

function stripStorePrefix(relativePath) {
  return relativePath.replace(/^node_modules\/\.pnpm\/[^/]+\/node_modules\//, "node_modules/");
}

/** Private filesystem roots that must never appear in emitted text or metadata. */
const PRIVATE_PATH_PATTERNS = [
  // A drive-letter root that is not the tail of a URL scheme such as `http:`.
  { name: "drive-letter path", pattern: /(?<![A-Za-z0-9+.\-_])[A-Za-z]:[\\/]/ },
  { name: "file URL", pattern: /file:\/\// },
  // A home directory at the start of a path, never a user segment inside a
  // Windows path or a `/home/` segment in an ordinary URL such as
  // `https://example.com/home/page`.
  { name: "unix home directory", pattern: /(?<![A-Za-z0-9+.\-_:])\/(?:Users|home)\/[^/"'`\s]/ },
  // The pnpm store keeps machine-specific hashes; nothing in the artifact needs it.
  { name: "pnpm store path", pattern: /node_modules\/\.pnpm\// },
  { name: "source map reference", pattern: /sourceMappingURL/ },
];

/**
 * Scans text that ships (or is cached) for private paths and source-map
 * references. Callers pass `{ fileName, text }` entries for text assets.
 */
export function checkPrivatePaths(entries) {
  const problems = [];
  for (const entry of entries) {
    for (const { name, pattern } of PRIVATE_PATH_PATTERNS) {
      const match = pattern.exec(entry.text);
      if (match) problems.push(`${entry.fileName}: ${name} (${match[0]})`);
    }
  }
  return problems;
}

/** No emitted file may be a source map, at any level. */
export function checkNoSourceMaps(emittedFiles) {
  return emittedFiles
    .filter((fileName) => extensionOf(fileName) === ".map")
    .map((fileName) => `${fileName}: source maps are not emitted`);
}

export function extensionOf(fileName) {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? "" : fileName.slice(index).toLowerCase();
}

export function packageRootOfModule(moduleId) {
  const match = /^node_modules\/(?:@[^/]+\/)?[^/]+/.exec(moduleId);
  return match ? match[0] : undefined;
}

/** Every emitted file stays inside `dist/ui` and uses an allowlisted extension. */
export function checkEmittedFiles(emittedFiles) {
  const problems = [];
  if (!Array.isArray(emittedFiles) || emittedFiles.length === 0) {
    return ["the build emitted no files"];
  }

  for (const fileName of emittedFiles) {
    if (typeof fileName !== "string" || fileName.length === 0) {
      problems.push(`emitted a nameless file entry: ${JSON.stringify(fileName)}`);
      continue;
    }
    if (fileName.includes("\\")) problems.push(`${fileName}: backslash in a served path`);
    if (fileName.startsWith("/") || /^[a-z]+:/i.test(fileName)) {
      problems.push(`${fileName}: absolute or external path`);
    }
    if (fileName.split("/").includes("..")) problems.push(`${fileName}: path traversal segment`);
    if (!fileName.startsWith("assets/") && fileName !== "index.html") {
      problems.push(`${fileName}: outside the served index.html plus assets/ layout`);
    }
    const extension = extensionOf(fileName);
    if (!UI_PACKAGED_ASSET_EXTENSIONS.includes(extension)) {
      problems.push(
        `${fileName}: extension ${extension || "(none)"} is not in the packaged allowlist`,
      );
    }
  }

  const html = emittedFiles.filter((fileName) => extensionOf(fileName) === ".html");
  if (html.length !== 1 || html[0] !== "index.html") {
    problems.push(`expected exactly one index.html entry point, saw ${JSON.stringify(html)}`);
  }
  if (!emittedFiles.some((fileName) => extensionOf(fileName) === ".js")) {
    problems.push("the build emitted no script chunk");
  }
  if (!emittedFiles.some((fileName) => extensionOf(fileName) === ".css")) {
    problems.push("the build emitted no stylesheet");
  }
  return problems;
}

/**
 * Import-graph checks: no `node:` or network module, no server-side `src/lib`
 * core or provider module, no foreign framework runtime, and the public UI
 * library is actually in the graph (R36 evidence at bundle level).
 */
export function checkModuleGraph(modules) {
  const problems = [];
  if (!Array.isArray(modules) || modules.length === 0) {
    return ["the recorded module graph is empty"];
  }

  for (const moduleId of modules) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(moduleId) || moduleId.startsWith("//")) {
      problems.push(`${moduleId}: external or built-in module reached the bundle`);
      continue;
    }
    if (moduleId.startsWith("/")) {
      problems.push(`${moduleId}: absolute path in the module graph`);
      continue;
    }
    const allowed =
      moduleId.startsWith("src/ui/") ||
      moduleId.startsWith("src/contracts/") ||
      moduleId.startsWith("node_modules/");
    if (!allowed) {
      problems.push(
        `${moduleId}: outside the browser-side module roots (src/ui, src/contracts, node_modules)`,
      );
    }
    if (moduleId.startsWith("src/lib/") || moduleId.startsWith("src/gui/")) {
      problems.push(`${moduleId}: a server-side module reached the browser bundle`);
    }
    const pkg = packageRootOfModule(moduleId);
    const bareName = pkg?.replace(/^node_modules\//, "");
    if (bareName && FOREIGN_RUNTIMES.includes(bareName)) {
      problems.push(`${moduleId}: a foreign framework runtime is in the bundle`);
    }
  }

  if (!modules.some((moduleId) => moduleId.startsWith("src/ui/"))) {
    problems.push("no src/ui module in the graph");
  }
  if (!modules.some((moduleId) => moduleId.startsWith("node_modules/@opencode/ui/"))) {
    problems.push("the public @opencode/ui library is missing from the bundle graph");
  }
  return problems;
}

function attributeValues(html, attribute) {
  const values = [];
  const pattern = new RegExp(`${attribute}\\s*=\\s*"([^"]*)"`, "gi");
  let match = pattern.exec(html);
  while (match !== null) {
    values.push(match[1]);
    match = pattern.exec(html);
  }
  return values;
}

/** `index.html` has no inline script and references same-origin assets only. */
export function checkIndexHtml(html) {
  const problems = [];
  if (typeof html !== "string" || html.length === 0) return ["index.html is empty"];

  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
  for (const tag of scriptTags) {
    if (!/\ssrc\s*=/i.test(tag)) problems.push(`inline script tag: ${tag}`);
    if (/type\s*=\s*"importmap"/i.test(tag)) problems.push("an import map is present");
  }
  const stylesheetTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of stylesheetTags) {
    if (!/\shref\s*=/i.test(tag)) problems.push(`link without href: ${tag}`);
  }

  for (const attribute of ["src", "href"]) {
    for (const value of attributeValues(html, attribute)) {
      if (!value.startsWith("/") || value.startsWith("//")) {
        problems.push(`${attribute}="${value}" is not a same-origin /assets path`);
      }
    }
  }
  if (!/<div\s+id="root"/i.test(html)) problems.push("index.html has no #root mount element");
  return problems;
}

/** Stylesheet `url()` tokens stay local: fonts ship from `dist/ui` (spec §9). */
export function checkStylesheetUrls(css) {
  const problems = [];
  const pattern = /url\(\s*("([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;
  let match = pattern.exec(String(css));
  while (match !== null) {
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (value.startsWith("data:")) {
      match = pattern.exec(String(css));
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
      problems.push(`stylesheet url(${value}) is an external request`);
    }
    match = pattern.exec(String(css));
  }
  return problems;
}

/** Shape of the metadata the build's own plugin writes. */
export function checkGraphMetadata(metadata) {
  const problems = [];
  if (!metadata || typeof metadata !== "object")
    return ["ui-graph.json is missing or not an object"];
  if (metadata.outDir !== UI_OUT_DIR) problems.push(`ui-graph.json outDir is ${metadata.outDir}`);
  if (metadata.htmlFile !== "index.html")
    problems.push(`ui-graph.json htmlFile is ${metadata.htmlFile}`);
  if (metadata.base !== "/") problems.push(`ui-graph.json base is ${metadata.base}`);
  if (!Array.isArray(metadata.modules)) problems.push("ui-graph.json has no modules array");
  if (!Array.isArray(metadata.emittedFiles))
    problems.push("ui-graph.json has no emittedFiles array");
  if (!Array.isArray(metadata.entryChunks) || metadata.entryChunks.length === 0) {
    problems.push("ui-graph.json records no entry chunk");
  }
  return problems;
}

/** Counts by extension, for the verifier's human-readable evidence line. */
export function summarizeExtensions(emittedFiles) {
  const counts = new Map();
  for (const fileName of emittedFiles) {
    const extension = extensionOf(fileName);
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}
