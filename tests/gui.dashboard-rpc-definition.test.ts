import { describe, expect, it } from "vitest";

import { DASHBOARD_RPC_ID, DashboardRpc } from "../src/rpc.js";
import {
  costedTokens,
  validGroupSnapshot,
  validHealth,
  validHomeSnapshot,
  validImportPreview,
  validProjectSnapshot,
  validQuotaSnapshot,
  validSessionSnapshot,
  validSettingsSnapshot,
  validSettingsWriteResult,
  validUsage,
} from "./helpers/dashboard-dto-fixtures.js";

type ValidateResult = { value?: unknown; issues?: ReadonlyArray<{ message: string }> };
type StandardSchema = {
  "~standard": {
    version: number;
    vendor: string;
    types?: unknown;
    validate: (value: unknown) => unknown;
  };
};

async function validate(schema: StandardSchema, value: unknown): Promise<ValidateResult> {
  return (await schema["~standard"].validate(value)) as ValidateResult;
}

async function expectAccepted(schema: StandardSchema, value: unknown): Promise<void> {
  const result = await validate(schema, value);
  expect(result.issues).toBeUndefined();
  expect(result.value).toEqual(value);
}

async function expectRejected(schema: StandardSchema, value: unknown, message: string) {
  const result = await validate(schema, value);
  expect(result.issues).toEqual([{ message }]);
  expect(result).not.toHaveProperty("value");
}

const methods = DashboardRpc.methods;

describe("dashboard RPC definition", () => {
  it("defines explicit typed methods, one invalidation event and no generic call", () => {
    expect(DashboardRpc.id).toBe(DASHBOARD_RPC_ID);
    expect(Object.keys(methods)).toEqual([
      "health",
      "quota",
      "home",
      "groups",
      "project",
      "session",
      "settings",
      "saveSettings",
      "saveVisibility",
      "importPreview",
      "importApply",
      "openSettingsFile",
      "watch",
    ]);
    expect(Object.keys(DashboardRpc.events)).toEqual(["invalidated"]);
  });

  it("uses Standard Schema v1 validators that carry no runtime types", () => {
    for (const method of Object.values(methods)) {
      for (const schema of [method.input, method.output]) {
        expect(schema["~standard"]).toEqual(
          expect.objectContaining({ version: 1, vendor: "opencode-quota-gui" }),
        );
        expect(schema["~standard"]).not.toHaveProperty("types");
      }
    }
    expect(DashboardRpc.events.invalidated.schema["~standard"]).toEqual(
      expect.objectContaining({ version: 1, vendor: "opencode-quota-gui" }),
    );
  });

  it("validates empty inputs", async () => {
    for (const method of [
      "health",
      "quota",
      "settings",
      "importPreview",
      "openSettingsFile",
    ] as const) {
      const input = methods[method].input;
      await expectAccepted(input, {});
      const normalized = await validate(input, undefined);
      expect(normalized.issues).toBeUndefined();
      expect(normalized.value).toEqual({});
      await expectRejected(input, null, "input must be an empty object");
      await expectRejected(input, { extra: true }, "input must be an empty object");
    }
  });

  it("validates home, project and session resource inputs", async () => {
    await expectAccepted(methods.home.input, { range: "30d" });
    await expectRejected(
      methods.home.input,
      { range: "90d" },
      "range must be one of 24h, 7d, 30d, lifetime",
    );
    await expectRejected(
      methods.home.input,
      { range: "7d", extra: true },
      "input must contain only range",
    );

    await expectAccepted(methods.project.input, { projectId: "project-1", range: "7d" });
    await expectRejected(
      methods.project.input,
      { projectId: "", range: "7d" },
      "projectId must be a non-empty resource id",
    );
    await expectRejected(
      methods.project.input,
      { projectId: "bad\u0000id", range: "7d" },
      "projectId must be a non-empty resource id",
    );
    await expectRejected(
      methods.project.input,
      { projectId: "p1" },
      "input must contain only projectId and range",
    );

    await expectAccepted(methods.session.input, { sessionId: "session-1" });
    await expectRejected(
      methods.session.input,
      { sessionId: "" },
      "sessionId must be a non-empty resource id",
    );
  });

  it("validates grouped analytics queries", async () => {
    await expectAccepted(methods.groups.input, { range: "7d", dimension: "model" });
    await expectAccepted(methods.groups.input, {
      range: "30d",
      dimension: "provider",
      filter: { dimension: "model", identity: { kind: "known", id: "gpt-5" } },
    });
    await expectRejected(
      methods.groups.input,
      { range: "7d", dimension: "account" },
      "input must be a grouped analytics query",
    );
    await expectRejected(
      methods.groups.input,
      { range: "7d", dimension: "model", extra: true },
      "input must contain only range and dimension",
    );
    await expectRejected(
      methods.groups.input,
      {
        range: "7d",
        dimension: "model",
        filter: { dimension: "model", identity: { kind: "unknown" } },
        extra: true,
      },
      "input must contain only range, dimension and filter",
    );
    await expectRejected(
      methods.groups.input,
      {
        range: "7d",
        dimension: "provider",
        filter: {
          dimension: "model",
          identity: { kind: "unknown" },
          extra: true,
        },
      },
      "input must be a grouped analytics query",
    );
    await expectRejected(
      methods.groups.input,
      {
        range: "7d",
        dimension: "provider",
        filter: {
          dimension: "model",
          identity: { kind: "known", id: "gpt-5", extra: true },
        },
      },
      "input must be a grouped analytics query",
    );
  });

  it("validates settings, visibility and import writes", async () => {
    await expectAccepted(methods.saveSettings.input, {
      patch: { minIntervalMs: 90_000, enabledProviders: ["openai"], nested: { value: true } },
      expectedRevision: "rev-1",
    });
    await expectRejected(
      methods.saveSettings.input,
      { patch: { value: () => 1 }, expectedRevision: "rev-1" },
      "patch values must be JSON values",
    );
    await expectRejected(
      methods.saveSettings.input,
      { patch: {}, expectedRevision: 1 },
      "expectedRevision must be a string",
    );
    await expectRejected(
      methods.saveSettings.input,
      { patch: {}, expectedRevision: "r", extra: true },
      "input must contain only patch and expectedRevision",
    );

    await expectAccepted(methods.saveVisibility.input, {
      hiddenCards: ["card-1"],
      hiddenRows: ["row-1"],
      expectedRevision: "rev-1",
    });
    await expectRejected(
      methods.saveVisibility.input,
      { hiddenCards: [], hiddenRows: [1], expectedRevision: "rev-1" },
      "hiddenRows must be a string array",
    );
    await expectRejected(
      methods.saveVisibility.input,
      { hiddenCards: [], hiddenRows: [] },
      "input must contain only hiddenCards, hiddenRows and expectedRevision",
    );

    await expectAccepted(methods.importApply.input, { expectedRevision: "rev-1" });
    await expectRejected(
      methods.importApply.input,
      { expectedRevision: 1 },
      "expectedRevision must be a string",
    );
    await expectRejected(
      methods.importApply.input,
      { expectedRevision: "r", extra: true },
      "input must contain only expectedRevision",
    );
  });

  it("validates the held viewer scope", async () => {
    await expectAccepted(methods.watch.input, { scope: "quota" });
    await expectAccepted(methods.watch.input, { scope: "analytics" });
    await expectRejected(
      methods.watch.input,
      { scope: "other" },
      "scope must be quota or analytics",
    );
    await expectRejected(
      methods.watch.input,
      { scope: "quota", extra: true },
      "input must contain only scope",
    );
    await expectRejected(methods.watch.output, { active: "yes" }, "output must report active");
  });

  it("validates invalidation events", async () => {
    const schema = DashboardRpc.events.invalidated.schema;
    await expectAccepted(schema, { topic: "quota.changed", at: 1 });
    await expectAccepted(schema, { topic: "settings.changed", at: 2, scope: "visibility" });
    await expectRejected(schema, null, "event must be an object");
    await expectRejected(schema, { topic: "nope", at: 1 }, "topic must be a dashboard event topic");
    await expectRejected(
      schema,
      { topic: "quota.changed", at: "now" },
      "at must be a finite number",
    );
    await expectRejected(
      schema,
      { topic: "quota.changed", at: 1, scope: "all" },
      "scope must be visibility",
    );
    await expectRejected(
      schema,
      { topic: "quota.changed", at: 1, extra: true },
      "event must contain only topic, at and scope",
    );
  });

  it("validates each output DTO rather than any object", async () => {
    const cases = [
      ["health", validHealth()],
      ["quota", validQuotaSnapshot()],
      ["home", validHomeSnapshot()],
      ["groups", validGroupSnapshot()],
      ["project", validProjectSnapshot()],
      ["session", validSessionSnapshot()],
      ["settings", validSettingsSnapshot()],
      ["saveSettings", validSettingsWriteResult()],
      ["saveVisibility", validSettingsWriteResult()],
      ["importPreview", validImportPreview()],
      ["importApply", validSettingsWriteResult()],
    ] as const;

    for (const [name, value] of cases) {
      await expectAccepted(methods[name].output, value);
      await expectRejected(
        methods[name].output,
        { any: "object" },
        "output does not match the dashboard contract",
      );
      for (const invalid of [undefined, null, "text", 1, []]) {
        const result = await validate(methods[name].output, invalid);
        expect(result.issues).toBeDefined();
      }
    }

    await expectAccepted(methods.openSettingsFile.output, { opened: true });
    await expectRejected(
      methods.openSettingsFile.output,
      { opened: false },
      "output must report opened",
    );
  });

  it("rejects malformed nested output payloads", async () => {
    await expectRejected(
      methods.quota.output,
      {
        ...validQuotaSnapshot(),
        providers: { cards: [{}], enabledProviders: "auto", polledAtMs: 1 },
      },
      "output does not match the dashboard contract",
    );
    await expectRejected(
      methods.home.output,
      {
        ...validHomeSnapshot(),
        usage: { ...validUsage(), totals: { ...costedTokens(), total: 1 } },
      },
      "output does not match the dashboard contract",
    );
    await expectRejected(
      methods.groups.output,
      {
        ...validGroupSnapshot(),
        filter: {
          dimension: "model",
          identity: { kind: "unknown", extra: true },
        },
      },
      "output does not match the dashboard contract",
    );
    await expectRejected(
      methods.session.output,
      {
        ...validSessionSnapshot(),
        steps: [{ sessionId: "s1", messageId: "m1", atMs: 1 }],
      },
      "output does not match the dashboard contract",
    );
  });

  it("allows only controlled error detail keys", async () => {
    const details = methods.health.errors?.internal;
    if (!details) throw new Error("expected an internal error schema");
    await expectAccepted(details, {});
    await expectAccepted(details, { key: "minIntervalMs" });
    await expectAccepted(details, { reason: "permission" });
    await expectRejected(
      details,
      { key: "minIntervalMs", extra: true },
      "error details may contain only key and reason",
    );
    await expectRejected(details, { key: 1 }, "key must be a string");
  });
});
