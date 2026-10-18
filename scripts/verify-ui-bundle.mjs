import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkEmittedFiles,
  checkGraphMetadata,
  checkIndexHtml,
  checkModuleGraph,
  checkNoSourceMaps,
  checkPrivatePaths,
  checkStylesheetUrls,
  extensionOf,
  summarizeExtensions,
  UI_GRAPH_METADATA_PATH,
  UI_OUT_DIR,
} from "./lib/ui-bundle-checks.mjs";

/**
 * Verifies the emitted UI bundle (design spec §11.1, R39).
 *
 * Run after `pnpm run build`: it reads the real `dist/ui` output plus the
 * module-graph metadata Vite's own `writeBundle` hook wrote into the build-only
 * dependency cache, and asserts on the import graph, the served paths, and the
 * absence of anything private — no absolute filesystem root, no drive letter, no
 * pnpm store path, and no source map — in either the shipped text or the
 * metadata. Legitimate inline strings (an SVG `xmlns`, a library-internal URL)
 * are not banned, and emitted font files are expected rather than treated as
 * unknown types.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outDir = path.join(repoRoot, UI_OUT_DIR);
const metadataPath = path.join(repoRoot, UI_GRAPH_METADATA_PATH);

/** Text assets are the only files that can carry a leaked path or a map reference. */
const TEXT_ASSET_EXTENSIONS = [".html", ".css", ".js", ".svg", ".json"];

function listFiles(dir, prefix = "") {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
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

function readMetadata() {
  try {
    return JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch (error) {
    console.error(
      `Run "pnpm run build" first: ${UI_GRAPH_METADATA_PATH} is unreadable (${error.message}).`,
    );
    process.exit(1);
  }
}

const metadata = readMetadata();
const problems = [...checkGraphMetadata(metadata)];

// The metadata is build-only evidence, but it is still held to the same privacy
// rule as anything that ships: no absolute root, no store path, ever.
problems.push(
  ...checkPrivatePaths([{ fileName: UI_GRAPH_METADATA_PATH, text: JSON.stringify(metadata) }]),
);

const problemsFromDisk = [];
if (!statSync(outDir, { throwIfNoEntry: false })?.isDirectory()) {
  problems.push(`${UI_OUT_DIR} does not exist`);
} else {
  const onDisk = listFiles(outDir).sort();
  const recorded = [...metadata.emittedFiles].sort();
  if (JSON.stringify(onDisk) !== JSON.stringify(recorded)) {
    problemsFromDisk.push(
      `dist/ui differs from the recorded build (on disk ${onDisk.length} files, recorded ${recorded.length})`,
    );
  }
  problemsFromDisk.push(...checkEmittedFiles(onDisk));
  problemsFromDisk.push(...checkNoSourceMaps(onDisk));

  const html = readFileSync(path.join(outDir, "index.html"), "utf8");
  problemsFromDisk.push(...checkIndexHtml(html));

  const textEntries = [{ fileName: "index.html", text: html }];
  for (const fileName of onDisk) {
    if (!TEXT_ASSET_EXTENSIONS.includes(extensionOf(fileName))) continue;
    const contents = readFileSync(path.join(outDir, fileName), "utf8");
    textEntries.push({ fileName, text: contents });
    if (extensionOf(fileName) !== ".css") continue;
    problemsFromDisk.push(
      ...checkStylesheetUrls(contents).map((problem) => `${fileName}: ${problem}`),
    );
  }
  problemsFromDisk.push(...checkPrivatePaths(textEntries));
}

problems.push(...problemsFromDisk);
problems.push(...checkModuleGraph(metadata.modules));

if (problems.length > 0) {
  console.error("The UI bundle does not satisfy the build contract:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

const packages = [
  ...new Set(
    metadata.modules
      .map((moduleId) => /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(moduleId)?.[1])
      .filter((name) => name !== undefined),
  ),
].sort();
const extensions = summarizeExtensions(metadata.emittedFiles);

console.log(
  `UI bundle verified: ${metadata.emittedFiles.length} files in ${UI_OUT_DIR} (${extensions
    .map(([extension, count]) => `${count}${extension}`)
    .join(
      ", ",
    )}), ${metadata.modules.length} modules across ${packages.length} packages (${packages.join(", ")}).`,
);
console.log(
  "Graph evidence: only src/ui, src/contracts and node_modules modules; index.html has no inline script and references same-origin /assets paths only.",
);
console.log(
  `Privacy: no source maps, and no absolute, drive-letter, home, or pnpm store path in ${metadata.emittedFiles.length} shipped files or in the build-only metadata (${UI_GRAPH_METADATA_PATH}).`,
);
