import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(repoRoot, "package.json");

const packageJsonRaw = await readFile(packageJsonPath, "utf8");
const packageJson = JSON.parse(packageJsonRaw);
const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";

if (!packageVersion) {
  console.error("package.json is missing a valid string version");
  process.exit(1);
}

// The publish workflow is manual and always passes the dispatched tag as
// RELEASE_TAG. Local runs (including `npm publish` via `prepublishOnly`) skip
// this check unless RELEASE_TAG is set; a stale GITHUB_REF from another CI or
// shell must never fail a local release. A RELEASE_TAG that is set but blank is
// an error, never a silent skip: the selected tag must always be checked.
const releaseTagEnv = process.env.RELEASE_TAG;
const explicitTag = (releaseTagEnv ?? "").trim();

let rawTag = "";
if (explicitTag) {
  rawTag = explicitTag;
} else if (releaseTagEnv !== undefined) {
  console.error("Unable to parse tag version from RELEASE_TAG (value is empty)");
  process.exit(1);
} else {
  console.log("No RELEASE_TAG set; skipping release version verification.");
  process.exit(0);
}

const tagVersion = rawTag.startsWith("v") ? rawTag.slice(1) : rawTag;

if (!tagVersion) {
  console.error("Unable to parse tag version from RELEASE_TAG");
  process.exit(1);
}

if (tagVersion !== packageVersion) {
  console.error(
    `Version mismatch: tag ${rawTag} expects ${tagVersion}, but package.json has ${packageVersion}`,
  );
  process.exit(1);
}

console.log(`Release version verified: ${rawTag} matches package.json ${packageVersion}`);
