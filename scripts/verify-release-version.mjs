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

// The manual tag-dispatch workflow passes the dispatched tag explicitly; local runs and
// tag-triggered contexts fall back to GITHUB_REF. A RELEASE_TAG that is set but blank is an
// error, never a silent skip: the workflow-selected tag must always be checked.
const releaseTagEnv = process.env.RELEASE_TAG;
const explicitTag = (releaseTagEnv ?? "").trim();
const githubRef = process.env.GITHUB_REF ?? "";
const tagPrefix = "refs/tags/";

let rawTag = "";
if (explicitTag) {
  rawTag = explicitTag;
} else if (releaseTagEnv !== undefined) {
  console.error("Unable to parse tag version from RELEASE_TAG (value is empty)");
  process.exit(1);
} else if (githubRef.startsWith(tagPrefix)) {
  rawTag = githubRef.slice(tagPrefix.length);
} else {
  console.log("No tag ref detected; skipping release version verification.");
  process.exit(0);
}

const tagVersion = rawTag.startsWith("v") ? rawTag.slice(1) : rawTag;

if (!tagVersion) {
  console.error(`Unable to parse tag version from ${explicitTag ? "RELEASE_TAG" : "GITHUB_REF"}`);
  process.exit(1);
}

if (tagVersion !== packageVersion) {
  console.error(
    `Version mismatch: tag ${rawTag} expects ${tagVersion}, but package.json has ${packageVersion}`,
  );
  process.exit(1);
}

console.log(`Release version verified: ${rawTag} matches package.json ${packageVersion}`);
