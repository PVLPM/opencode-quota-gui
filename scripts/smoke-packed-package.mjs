import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolvePackageManagerInvocation, verifyReleaseArtifact } from "./lib/release-artifact.mjs";

const inputPath = path.resolve(process.argv[2] ?? "package-artifacts");
const nodeMajor = Number(process.versions.node.split(".")[0]);

if (nodeMajor !== 22 && nodeMajor !== 24) {
  console.error(
    `Packed runtime smoke requires Node 22 or 24; received Node ${process.versions.node}.`,
  );
  process.exit(1);
}

function run(command, args, cwd, options = {}) {
  const { env: optionEnv, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: path.join(cwd, ".npm-cache"),
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      ...optionEnv,
    },
    ...spawnOptions,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

const artifact = await verifyReleaseArtifact(inputPath);
const tarball = artifact.tarballPath;
const npm = resolvePackageManagerInvocation("npm");
const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const sdkMetricsVersion = rootPackage.devDependencies?.["@opentelemetry/sdk-metrics"];
if (!/^\d+\.\d+\.\d+$/.test(sdkMetricsVersion ?? "")) {
  throw new Error("Expected an exact development-only @opentelemetry/sdk-metrics version.");
}
const workdir = await mkdtemp(path.join(tmpdir(), "opencode-quota-package-smoke-"));

try {
  run(npm.command, [...npm.args, "init", "-y"], workdir);
  run(npm.command, [...npm.args, "install", "--omit=dev", tarball], workdir);

  const moduleSmoke = `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import path from "node:path";
    import { fileURLToPath, pathToFileURL } from "node:url";

    const rootExportUrl = import.meta.resolve("opencode-quota-gui");
    const { default: server } = await import("opencode-quota-gui");
    await import("opencode-quota-gui/server");
    assert.equal(typeof server.setup, "function");
    const { metrics } = await import("@opentelemetry/api");
    assert.equal(typeof metrics.getMeter, "function");

    let tuiError;
    try {
      await import("opencode-quota-gui/tui");
    } catch (error) {
      tuiError = error;
    }
    assert.equal(tuiError?.code, "ERR_PACKAGE_PATH_NOT_EXPORTED");

    const pkg = JSON.parse(
      await readFile("node_modules/opencode-quota-gui/package.json", "utf8"),
    );
    assert.equal(pkg.exports?.["./tui"], undefined);
    assert.equal(pkg.engines?.node, "^22.13.0 || >=23.4.0");
    assert.equal(pkg.dependencies?.["@opentelemetry/api"], "~1.9.1");
    for (const dependencyType of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
      assert.equal(pkg[dependencyType]?.["@opentelemetry/api"], undefined);
    }
    assert.equal(pkg.peerDependenciesMeta?.["@opentelemetry/api"], undefined);
    for (const dependencyType of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      assert.equal(pkg[dependencyType]?.["@opentelemetry/sdk-metrics"], undefined);
    }

    const packageRoot = path.resolve(path.dirname(fileURLToPath(rootExportUrl)), "..");
    let tuiEntryError;
    try {
      await readFile(path.join(packageRoot, "dist", "tui.js"), "utf8");
    } catch (error) {
      tuiEntryError = error;
    }
    assert.equal(tuiEntryError?.code, "ENOENT");

    const telemetry = await import(
      pathToFileURL(path.join(packageRoot, "dist", "lib", "quota-telemetry.js"))
    );
    assert.ok(
      telemetry.configureQuotaTelemetry({
        owner: {},
        enabled: true,
        identity: "packed-runtime-dependency",
      }),
    );
    await telemetry.__flushQuotaTelemetryInitializationForTests();
  `;

  run(process.execPath, ["--input-type=module", "--eval", moduleSmoke], workdir);

  run(
    npm.command,
    [...npm.args, "install", "--omit=dev", `@opentelemetry/sdk-metrics@${sdkMetricsVersion}`],
    workdir,
  );

  const realOtelFixture = path.join(workdir, "smoke-packed-real-otel.mjs");
  await copyFile(
    new URL("./fixtures/smoke-packed-real-otel.mjs", import.meta.url),
    realOtelFixture,
  );
  const isolatedRuntimeEnv = {
    XDG_CACHE_HOME: path.join(workdir, "runtime", "cache"),
    XDG_CONFIG_HOME: path.join(workdir, "runtime", "config"),
    XDG_DATA_HOME: path.join(workdir, "runtime", "data"),
    XDG_STATE_HOME: path.join(workdir, "runtime", "state"),
  };
  for (const scenario of ["happy", "disabled", "no-global-provider", "failing-infrastructure"]) {
    run(process.execPath, [realOtelFixture, scenario], workdir, { env: isolatedRuntimeEnv });
  }

  const openRouterSecret = "packed-openrouter-secret-canary";
  const openRouterEnv = { ...isolatedRuntimeEnv, OPENROUTER_API_KEY: openRouterSecret };
  run(process.execPath, [realOtelFixture, "seed-production-openrouter"], workdir, {
    env: openRouterEnv,
  });

  const cliPath = path.join(
    workdir,
    "node_modules",
    "opencode-quota-gui",
    "dist",
    "bin",
    "opencode-quota-gui.js",
  );
  const cliOutput = run(process.execPath, [cliPath, "--help"], workdir);
  for (const expected of [
    "Usage:",
    "opencode-quota-gui init",
    "opencode-quota-gui update",
    "opencode-quota-gui --help",
    "opencode-quota-gui --version",
  ]) {
    if (!cliOutput.includes(expected)) {
      throw new Error(`Packed CLI help is missing: ${expected}`);
    }
  }
  for (const removed of [
    "opencode-quota-gui show",
    "opencode-quota-gui status",
    "provider add",
    "--sync-legacy-config",
  ]) {
    if (cliOutput.includes(removed)) {
      throw new Error(`Packed CLI help advertises a removed command: ${removed}`);
    }
  }
  const versionOutput = run(process.execPath, [cliPath, "--version"], workdir).trim();
  if (versionOutput !== rootPackage.version) {
    throw new Error(
      `Packed CLI version mismatch: expected ${rootPackage.version}, received ${versionOutput}`,
    );
  }

  run(process.execPath, [realOtelFixture, "read-production-openrouter-cache"], workdir, {
    env: openRouterEnv,
  });

  const readTree = async (directory) => {
    const chunks = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) chunks.push(...(await readTree(target)));
      else if (entry.isFile()) chunks.push(await readFile(target, "utf8"));
    }
    return chunks;
  };
  const privateArtifacts = [...(await readTree(path.join(workdir, "runtime")))].join("\n");
  assert.ok(!privateArtifacts.includes(openRouterSecret));
  assert.ok(!privateArtifacts.includes("resolvedAuthIdentity"));
  assert.ok(!privateArtifacts.includes("rai1_"));

  const alibabaTokenPlanFixture = path.join(workdir, "smoke-packed-alibaba-token-plan.mjs");
  await copyFile(
    new URL("./fixtures/smoke-packed-alibaba-token-plan.mjs", import.meta.url),
    alibabaTokenPlanFixture,
  );
  run(process.execPath, [alibabaTokenPlanFixture], workdir, { env: isolatedRuntimeEnv });

  console.log(
    `Packed package smoke passed for ${artifact.filename} on Node ${process.versions.node} with packaged @opentelemetry/api and host-owned @opentelemetry/sdk-metrics ${sdkMetricsVersion} (sha256 ${artifact.sha256}).`,
  );
} finally {
  await rm(workdir, { recursive: true, force: true });
}
