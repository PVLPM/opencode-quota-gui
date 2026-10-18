import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import type { JsonValue } from "../src/contracts/dashboard.js";

interface WorkflowInput {
  description?: string;
  required?: boolean;
  type?: string;
  default?: JsonValue;
}

interface WorkflowDispatch {
  inputs?: Record<string, WorkflowInput>;
}

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  "continue-on-error"?: boolean;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, JsonValue>;
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  strategy?: { matrix?: Record<string, JsonValue[]> };
}

interface Workflow {
  on?: { workflow_dispatch?: WorkflowDispatch };
  env?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

const workflowPath = new URL("../.github/workflows/publish-npm.yml", import.meta.url);
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow: Workflow = parse(workflowSource);

const PUBLISH_GUARD = "${{ vars.NPM_PUBLISH_ENABLED == 'true' && inputs.publish == true }}";
const TAG_REF = "refs/tags/${{ inputs.tag }}";
const REHEARSAL_JOB_NAMES = ["release-package", "runtime-smoke"];

function jobRunLines(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) =>
    (step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = (job.steps ?? []).find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

function stepIndex(job: WorkflowJob, name: string): number {
  return (job.steps ?? []).findIndex((candidate) => candidate.name === name);
}

describe("GUI release safety", () => {
  it("stays workflow_dispatch only with a required tag input and a disabled-by-default publish confirmation", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);

    const dispatch = workflow.on?.workflow_dispatch ?? {};
    expect(Object.keys(dispatch.inputs ?? {}).sort()).toEqual(["publish", "tag"]);
    expect(dispatch.inputs?.tag).toEqual({
      description: expect.any(String),
      required: true,
      type: "string",
    });
    expect(dispatch.inputs?.publish).toEqual({
      description: expect.any(String),
      required: true,
      type: "boolean",
      default: false,
    });

    for (const event of ["release", "push", "schedule", "workflow_call"]) {
      expect(workflow.on ?? {}).not.toHaveProperty(event);
    }
  });

  it("references only the dispatched tag and publish inputs, never release-event context", () => {
    for (const forbidden of [
      "github.event",
      "github.ref",
      "github.sha",
      "RELEASE_PRERELEASE",
      "target_commitish",
      "default_branch",
      "dist-tags",
    ]) {
      expect(workflowSource).not.toContain(forbidden);
    }
    expect(workflowSource).toContain("inputs.tag");
    expect(workflowSource).toContain("inputs.publish == true");
  });

  it("guards publish behind both the repository opt-in and the explicit dispatch confirmation", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(["publish", ...REHEARSAL_JOB_NAMES].sort());
    expect(workflow.jobs.publish.if).toBe(PUBLISH_GUARD);

    for (const jobName of REHEARSAL_JOB_NAMES) {
      const job = workflow.jobs[jobName];
      expect(job, `Missing workflow job: ${jobName}`).toBeDefined();
      expect(job.if, `${jobName} must remain manually runnable`).toBeUndefined();
    }
  });

  it("keeps npm publish inside the guarded publish job and repository writes out of every job", () => {
    const jobsWithNpmPublish = Object.entries(workflow.jobs)
      .filter(([, job]) => jobRunLines(job).some((line) => /\bnpm publish\b/u.test(line)))
      .map(([name]) => name);

    expect(jobsWithNpmPublish).toEqual(["publish"]);

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      expect(job.permissions?.contents, `${jobName} must not write contents`).not.toBe("write");
      for (const line of jobRunLines(job)) {
        expect(line, `${jobName} must not push`).not.toMatch(/\bgit push\b/u);
        expect(line, `${jobName} must not rewrite the version`).not.toMatch(/\bpnpm version\b/u);
        expect(line, `${jobName} must not touch the lockfile only`).not.toContain(
          "--lockfile-only",
        );
        expect(line, `${jobName} must not manage dist-tags`).not.toMatch(/\bdist-tag add\b/u);
      }
    }
    expect(workflowSource).not.toContain("contents: write");
  });

  it("checks out the requested tag everywhere and verifies tag, commit, and package version", () => {
    const checkouts = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      (job.steps ?? [])
        .filter((step) => step.uses === "actions/checkout@v6")
        .map((step) => ({ jobName, ref: step.with?.ref })),
    );
    expect(checkouts.map((checkout) => checkout.jobName).sort()).toEqual(
      ["publish", ...REHEARSAL_JOB_NAMES].sort(),
    );
    for (const checkout of checkouts) expect(checkout.ref).toBe(TAG_REF);

    const release = workflow.jobs["release-package"];
    const assertion = namedStep(release, "Assert tag, commit, and package version match");
    const assertionRun = assertion.run ?? "";
    expect(assertion.env).toEqual({ RELEASE_TAG: "${{ inputs.tag }}" });
    // The version check cannot be conditionally skipped or downgraded: it always runs for
    // the dispatched tag and uses the explicit RELEASE_TAG env, never a GITHUB_REF rewrite.
    expect(assertion.if, "version assertion must not be conditional").toBeUndefined();
    expect(
      assertion["continue-on-error"],
      "version assertion must not be advisory",
    ).toBeUndefined();
    expect(assertionRun).toContain('[ -z "$RELEASE_TAG" ]');
    expect(assertionRun).toContain("pnpm run verify:release-version");
    expect(assertionRun).not.toContain("GITHUB_REF");
    expect(assertionRun).toContain(
      'git rev-parse --verify --quiet "refs/tags/$RELEASE_TAG^{commit}"',
    );
    expect(assertionRun).toContain('CHECKED_OUT_SHA="$(git rev-parse HEAD)"');
    expect(assertionRun).toContain('TAG_SHA="$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")"');

    const orderedSteps = [
      "Checkout release tag",
      "Setup Node.js 24",
      "Activate pnpm",
      "Assert tag, commit, and package version match",
      "Install dependencies",
      "Run canonical verification",
      "Pack and audit the release artifact once",
      "Upload exact release artifact",
    ];
    for (const name of orderedSteps) expect(stepIndex(release, name)).toBeGreaterThanOrEqual(0);
    for (let index = 1; index < orderedSteps.length; index += 1) {
      expect(stepIndex(release, orderedSteps[index])).toBeGreaterThan(
        stepIndex(release, orderedSteps[index - 1]),
      );
    }

    expect(namedStep(release, "Run canonical verification").run).toBe("pnpm verify");
    expect(namedStep(release, "Pack and audit the release artifact once").run).toBe(
      "pnpm run pack:release-package package-artifacts",
    );
    expect(
      (release.steps ?? []).filter((step) => step.run?.includes("pnpm run pack:release-package")),
    ).toHaveLength(1);
    expect(namedStep(release, "Upload exact release artifact").with).toEqual({
      name: "release-package",
      path: "package-artifacts/*",
      "if-no-files-found": "error",
    });
  });

  it("smoke-tests the exact packed artifact on Node 22 and 24 before any publish", () => {
    const smoke = workflow.jobs["runtime-smoke"];
    expect(smoke.needs).toBe("release-package");
    expect(smoke.strategy?.matrix?.["node-version"]).toEqual(["22.x", "24.x"]);
    expect(namedStep(smoke, "Download exact release artifact").with).toEqual({
      name: "release-package",
      path: "package-artifacts",
    });
    expect(
      namedStep(smoke, "Smoke exact release artifact on Node ${{ matrix.node-version }}").run,
    ).toBe("node scripts/smoke-packed-package.mjs package-artifacts");

    const publish = workflow.jobs.publish;
    expect(publish.needs).toEqual(["release-package", "runtime-smoke"]);
    expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(namedStep(publish, "Download exact release artifact").with).toEqual({
      name: "release-package",
      path: "package-artifacts",
    });
    expect(stepIndex(publish, "Choose npm dist-tag")).toBeLessThan(
      stepIndex(publish, "Verify and publish exact release artifact"),
    );

    const publishRun = namedStep(publish, "Verify and publish exact release artifact").run ?? "";
    expect(publishRun).toContain("node scripts/verify-release-artifact.mjs package-artifacts");
    expect(publishRun).toContain(
      'npm publish "./${TARBALLS[0]}" --tag "$DIST_TAG" --access public --provenance --ignore-scripts',
    );
    expect(publishRun).not.toContain("pnpm pack");
    expect(publishRun).not.toContain("pack:release-package");
    expect(publishRun).not.toContain("pnpm run build");
  });

  it("derives the npm dist-tag from the dispatched tag version only", () => {
    const chooseTag = namedStep(workflow.jobs.publish, "Choose npm dist-tag");
    expect(chooseTag.id).toBe("dist-tag");
    expect(chooseTag.env).toEqual({ RELEASE_TAG: "${{ inputs.tag }}" });

    const chooseTagRun = chooseTag.run ?? "";
    expect(chooseTagRun).toContain('VERSION="${RELEASE_TAG#v}"');
    expect(chooseTagRun).toContain("*-*");
    expect(chooseTagRun).toContain('echo "dist-tag=$DIST_TAG" >> "$GITHUB_OUTPUT"');
    expect(chooseTagRun).not.toContain("prerelease");
  });

  it("hoists the single package-name literal to one workflow-level env entry", () => {
    expect(workflow.env).toEqual({ PACKAGE_NAME: "opencode-quota-gui" });
    expect(workflowSource.match(/opencode-quota-gui/gu)).toHaveLength(1);
    expect(workflowSource).not.toContain("@slkiser/opencode-quota");
  });
});
