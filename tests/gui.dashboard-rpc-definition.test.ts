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
  it("keeps watch attempt nonces optional for legacy callers and validates bound snapshots", async () => {
    await expectAccepted(methods.watch.input, { scope: "analytics" });
    await expectAccepted(methods.watch.input, {
      scope: "analytics",
      attemptNonce: "opaque-attempt-nonce",
    });
    await expectRejected(
      methods.watch.input,
      { scope: "analytics", attemptNonce: "" },
      "attemptNonce must be a non-empty safe string",
    );

    await expectAccepted(DashboardRpc.events.invalidated.schema, {
      topic: "cache.observer",
      at: 1,
      cacheObserverEvent: {
        type: "source.status",
        created: 1,
        data: {
          state: "unverified",
          attemptNonce: "opaque-attempt-nonce",
          sourceBinding: "source-owner-a",
        },
      },
    });
  });

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
    expect(Object.keys(DashboardRpc.events)).toEqual(["invalidated", "quotaNotification"]);
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

  it("accepts only a boolean quota refresh flag", async () => {
    await expectAccepted(methods.quota.input, { refresh: true });
    await expectAccepted(methods.quota.input, { refresh: false });
    await expectRejected(methods.quota.input, { refresh: "true" }, "refresh must be boolean");
    await expectRejected(
      methods.quota.input,
      { refresh: true, extra: true },
      "input must be an empty object",
    );
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
    await expectAccepted(methods.watch.input, { scope: "quota", attemptNonce: "nonce-quota" });
    await expectAccepted(methods.watch.input, {
      scope: "analytics",
      attemptNonce: "nonce-analytics",
    });
    await expectRejected(
      methods.watch.input,
      { scope: "other", attemptNonce: "nonce-other" },
      "scope must be quota or analytics",
    );
    await expectRejected(
      methods.watch.input,
      { scope: "quota", attemptNonce: "nonce-quota", extra: true },
      "input must contain only scope and attemptNonce",
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
      "event must contain only topic, at, scope and cacheObserverEvent",
    );
  });

  it("validates minimal cache observer payloads on their isolated event topic", async () => {
    const schema = DashboardRpc.events.invalidated.schema;
    const cacheObserverEvent = {
      type: "session.step.ended",
      created: 3,
      data: {
        sessionID: "ses-1",
        assistantMessageID: "msg-1",
        tokens: { input: 0, cache: { read: 0 } },
      },
    };

    await expectAccepted(schema, {
      topic: "cache.observer",
      at: 3,
      cacheObserverEvent,
    });
    await expectAccepted(schema, {
      topic: "cache.observer",
      at: 4,
      cacheObserverEvent: {
        type: "source.status",
        created: 4,
        data: { state: "observed" },
      },
    });
    await expectAccepted(schema, {
      topic: "cache.observer",
      at: 5,
      cacheObserverEvent: {
        type: "session.created",
        data: { sessionID: "ses-child", parentID: "ses-root" },
      },
    });
    await expectAccepted(schema, {
      topic: "cache.observer",
      at: 6,
      cacheObserverEvent: {
        type: "session.forked",
        data: { sessionID: "ses-fork", parentID: "ses-root" },
      },
    });
    await expectRejected(
      schema,
      { topic: "cache.observer", at: 3 },
      "cache.observer topic requires a valid cache observer payload",
    );
    await expectRejected(
      schema,
      { topic: "sessions.changed", at: 3, cacheObserverEvent },
      "cache observer payload requires the cache.observer topic",
    );
    await expectRejected(
      schema,
      {
        topic: "cache.observer",
        at: 3,
        cacheObserverEvent: {
          ...cacheObserverEvent,
          data: { ...cacheObserverEvent.data, prompt: "must never cross the RPC boundary" },
        },
      },
      "cache.observer topic requires a valid cache observer payload",
    );
    await expectRejected(
      schema,
      {
        topic: "cache.observer",
        at: 3,
        cacheObserverEvent: {
          ...cacheObserverEvent,
          data: {
            ...cacheObserverEvent.data,
            tokens: { ...cacheObserverEvent.data.tokens, output: 99 },
          },
        },
      },
      "cache.observer topic requires a valid cache observer payload",
    );
  });

  it("validates safe quota notification events on their own channel", async () => {
    const schema = DashboardRpc.events.quotaNotification.schema;
    await expectAccepted(schema, {
      id: `${"a".repeat(64)}:1762084920000`,
      kind: "low",
      title: "OpenAI quota low",
      description: "work: 5-hour window: 5% remaining.",
    });
    await expectAccepted(schema, {
      id: "opaque",
      kind: "provider-error",
      title: "OpenAI quota error",
    });
    await expectRejected(schema, null, "event must be an object");
    await expectRejected(
      schema,
      { id: "x", kind: "nope", title: "T" },
      "kind must be a quota notification kind",
    );
    await expectRejected(
      schema,
      { id: "x", kind: "low", title: "" },
      "title must be a safe non-empty string",
    );
    await expectRejected(
      schema,
      { id: "x", kind: "low", title: "T", description: "line\nbreak" },
      "description must be a safe non-empty string when present",
    );
    await expectRejected(
      schema,
      { id: "x", kind: "low", title: "T", extra: "raw provider body" },
      "event must contain only id, kind, title and description",
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
