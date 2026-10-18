import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import type { JsonValue } from "../src/contracts/dashboard.js";

interface WorkflowStep {
  name?: string;
  if?: string;
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
}

interface Workflow {
  on?: Record<string, JsonValue>;
  env?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

const workflowPath = new URL("../.github/workflows/publish-npm.yml", import.meta.url);
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow: Workflow = parse(workflowSource);

const PUBLISH_GUARD = "${{ vars.NPM_PUBLISH_ENABLED == 'true' }}";
const GUARDED_JOB_NAMES = ["publish", "point-next-at-stable", "backfill-version"];
const UNGUARDED_REHEARSAL_JOB_NAMES = ["release-package", "runtime-smoke"];

function jobRunLines(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) =>
    (step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

describe("GUI release safety", () => {
  it("never runs on release events and stays workflow_dispatch only", () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.on).not.toHaveProperty("release");
  });

  it("guards publish, point-next-at-stable, and backfill-version behind vars.NPM_PUBLISH_ENABLED", () => {
    for (const jobName of GUARDED_JOB_NAMES) {
      const job = workflow.jobs[jobName];
      expect(job, `Missing workflow job: ${jobName}`).toBeDefined();
      expect(job.if, `${jobName} must stay guarded`).toBe(PUBLISH_GUARD);
    }
  });

  it("leaves release-package and runtime-smoke unguarded for publish-free rehearsals", () => {
    for (const jobName of UNGUARDED_REHEARSAL_JOB_NAMES) {
      const job = workflow.jobs[jobName];
      expect(job, `Missing workflow job: ${jobName}`).toBeDefined();
      expect(job.if, `${jobName} must remain manually runnable`).toBeUndefined();
    }
  });

  it("allows npm publish only inside the guarded publish job", () => {
    const jobsWithNpmPublish = Object.entries(workflow.jobs)
      .filter(([, job]) => jobRunLines(job).some((line) => /\bnpm publish\b/u.test(line)))
      .map(([name]) => name);

    expect(jobsWithNpmPublish).toEqual(["publish"]);
    expect(workflow.jobs.publish.if).toBe(PUBLISH_GUARD);
  });

  it("allows git push only inside the guarded backfill-version job", () => {
    const jobsWithGitPush = Object.entries(workflow.jobs)
      .filter(([, job]) => jobRunLines(job).some((line) => /\bgit push\b/u.test(line)))
      .map(([name]) => name);

    expect(jobsWithGitPush).toEqual(["backfill-version"]);
    expect(workflow.jobs["backfill-version"].if).toBe(PUBLISH_GUARD);
  });

  it("hoists the single package-name literal to one workflow-level env entry", () => {
    expect(workflow.env).toEqual({ PACKAGE_NAME: "opencode-quota-gui" });
    expect(workflowSource.match(/opencode-quota-gui/gu)).toHaveLength(1);
    expect(workflowSource).not.toContain("@slkiser/opencode-quota");
  });
});
