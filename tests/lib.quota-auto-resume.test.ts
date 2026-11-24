import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createQuotaAutoResumption,
  QUOTA_AUTO_RESUME_GRACE_MS,
  QUOTA_AUTO_RESUME_PROMPT,
  QUOTA_AUTO_RESUME_SOURCE,
  type QuotaAutoResumeEvent,
  type QuotaAutoResumeSessionInfo,
} from "../src/lib/quota-auto-resume.js";
import type { QuotaWindowCollection } from "../src/lib/quota-retry-wait.js";

const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE_MS = 60_000;
const RESET_MS = NOW_MS + 10 * MINUTE_MS;
const SESSION_ID = "session-1";
const MODEL = { id: "glm-4.6", providerID: "zai-coding-plan" };

function exhausted(): QuotaWindowCollection {
  return {
    binding: { kind: "account", sourceId: "account-1" },
    windows: [{ key: "window:fiveHour", percentRemaining: 0, resetMs: RESET_MS }],
  };
}

function recovered(): QuotaWindowCollection {
  return {
    binding: { kind: "account", sourceId: "account-1" },
    windows: [
      { key: "window:fiveHour", percentRemaining: 100, resetMs: RESET_MS + 5 * 60 * 60_000 },
    ],
  };
}

function failedEvent(
  error: Record<string, unknown> = { type: "provider.quota" },
): QuotaAutoResumeEvent {
  return {
    type: "session.execution.failed",
    created: NOW_MS,
    data: { sessionID: SESSION_ID, error },
  };
}

function sessionInfo(
  overrides: Partial<QuotaAutoResumeSessionInfo> = {},
): QuotaAutoResumeSessionInfo {
  return {
    model: MODEL,
    outcome: "failed",
    time: { idle: NOW_MS - 1_000 },
    ...overrides,
  };
}

function makeHarness(
  options: {
    probes?: Array<QuotaWindowCollection | undefined>;
    info?: QuotaAutoResumeSessionInfo;
  } = {},
) {
  const probe = vi.fn();
  for (const result of options.probes ?? [exhausted(), recovered(), recovered()]) {
    probe.mockResolvedValueOnce(result);
  }
  const info = options.info ?? sessionInfo();
  const get = vi.fn(async () => info);
  const prompt = vi.fn(async () => ({}));
  const log = vi.fn();
  const controller = createQuotaAutoResumption({
    probe,
    session: { get, prompt },
    log,
  });
  return { controller, probe, get, prompt, log, info };
}

async function flushTimers(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("quota auto-resume", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not arm for a non-quota terminal failure", async () => {
    const { controller, probe, prompt } = makeHarness();
    controller.handleEvent(failedEvent({ type: "provider.auth", status: 401 }));
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(probe).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("waits for the same window to reset, then sends one continue after the grace", async () => {
    const { controller, probe, prompt } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).toHaveBeenCalledWith(MODEL);

    // The reset window has not passed yet.
    await flushTimers(RESET_MS - NOW_MS + 60_000 - 1);
    expect(prompt).not.toHaveBeenCalled();

    // The first recovery observation starts the two-minute inactivity grace.
    await flushTimers(1);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS - 1);
    expect(prompt).not.toHaveBeenCalled();

    await flushTimers(1);
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith({
      sessionID: SESSION_ID,
      text: QUOTA_AUTO_RESUME_PROMPT,
      metadata: { source: QUOTA_AUTO_RESUME_SOURCE, failureAt: NOW_MS },
    });
  });

  it("keeps waiting when a different exhausted window still has a reset ahead", async () => {
    const laterResetMs = RESET_MS + 4 * 60 * MINUTE_MS;
    const { controller, prompt } = makeHarness({
      probes: [
        {
          binding: { kind: "account", sourceId: "account-1" },
          windows: [
            { key: "window:fiveHour", percentRemaining: 0, resetMs: RESET_MS },
            { key: "window:weekly", percentRemaining: 0, resetMs: RESET_MS + 2 * 60 * MINUTE_MS },
          ],
        },
        {
          binding: { kind: "account", sourceId: "account-1" },
          windows: [
            { key: "window:fiveHour", percentRemaining: 100, resetMs: RESET_MS },
            { key: "window:weekly", percentRemaining: 0, resetMs: laterResetMs },
          ],
        },
        {
          binding: { kind: "account", sourceId: "account-1" },
          windows: [
            { key: "window:fiveHour", percentRemaining: 100, resetMs: RESET_MS },
            { key: "window:weekly", percentRemaining: 100, resetMs: laterResetMs },
          ],
        },
        {
          binding: { kind: "account", sourceId: "account-1" },
          windows: [
            { key: "window:fiveHour", percentRemaining: 100, resetMs: RESET_MS },
            { key: "window:weekly", percentRemaining: 100, resetMs: laterResetMs },
          ],
        },
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(RESET_MS - NOW_MS + 60_000);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(2 * 60 * MINUTE_MS);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(2 * 60 * MINUTE_MS);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("refuses recovery when the exhausted window identity disappears", async () => {
    const { controller, prompt } = makeHarness({
      probes: [
        exhausted(),
        {
          binding: { kind: "account", sourceId: "account-1" },
          windows: [{ key: "window:weekly", percentRemaining: 100 }],
        },
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(RESET_MS - NOW_MS + 60_000 + QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("refuses recovery for a different active account", async () => {
    const { controller, prompt } = makeHarness({
      probes: [
        exhausted(),
        {
          binding: { kind: "account", sourceId: "account-2" },
          windows: [{ key: "window:fiveHour", percentRemaining: 100 }],
        },
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(RESET_MS - NOW_MS + 60_000 + QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("arms with a stable provider-scope identity", async () => {
    const binding = {
      kind: "provider-scope",
      providerId: "claude-agent",
      scope: "rai1_claude_a",
    } as const;
    const { controller, prompt } = makeHarness({
      probes: [
        {
          binding,
          windows: [{ key: "window:five_hour", percentRemaining: 0, resetMs: RESET_MS }],
        },
        {
          binding,
          windows: [{ key: "window:five_hour", percentRemaining: 100, resetMs: RESET_MS }],
        },
        {
          binding,
          windows: [{ key: "window:five_hour", percentRemaining: 100, resetMs: RESET_MS }],
        },
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(RESET_MS - NOW_MS + 60_000 + QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("refuses recovery when the provider-scope identity changes", async () => {
    const binding = (scope: string) =>
      ({ kind: "provider-scope", providerId: "claude-agent", scope }) as const;
    const { controller, prompt } = makeHarness({
      probes: [
        {
          binding: binding("rai1_claude_a"),
          windows: [{ key: "window:five_hour", percentRemaining: 0, resetMs: RESET_MS }],
        },
        {
          binding: binding("rai1_claude_b"),
          windows: [{ key: "window:five_hour", percentRemaining: 100, resetMs: RESET_MS }],
        },
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(RESET_MS - NOW_MS + 60_000 + QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not arm without an exhausted window or a known reset", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [
        {
          binding: { kind: "account", sourceId: "account-1" },
          windows: [{ key: "window:fiveHour", percentRemaining: 40 }],
        },
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(prompt).not.toHaveBeenCalled();

    const second = makeHarness({
      probes: [
        {
          binding: { kind: "account", sourceId: "account-1" },
          windows: [{ key: "window:fiveHour", percentRemaining: 0 }],
        },
      ],
    });
    second.controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(second.prompt).not.toHaveBeenCalled();
  });

  it("does not arm when an exhausted window has no stable identity", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [
        {
          binding: { kind: "account", sourceId: "account-1" },
          windows: [{ percentRemaining: 0, resetMs: RESET_MS }],
        },
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not arm when the failed route has no account binding", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [
        {
          windows: [{ key: "window:fiveHour", percentRemaining: 0, resetMs: RESET_MS }],
        },
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not arm when recovery loses the account binding", async () => {
    const { controller, prompt } = makeHarness({
      probes: [
        exhausted(),
        {
          windows: [{ key: "window:fiveHour", percentRemaining: 100, resetMs: RESET_MS }],
        },
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_MS - NOW_MS + 60_000);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not arm again after its own continue execution fails", async () => {
    const { controller, probe, prompt } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_MS - NOW_MS + 60_000 - 1);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(1);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
    const probeCallsBefore = probe.mock.calls.length;

    // The host starts the execution created by our marked continue, then it fails on quota.
    controller.handleEvent({
      type: "session.execution.started",
      created: NOW_MS,
      data: { sessionID: SESSION_ID },
    });
    controller.handleEvent(failedEvent());
    await flushTimers(24 * 60 * MINUTE_MS);

    expect(prompt).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledTimes(probeCallsBefore);
  });

  it("allows one new auto-resume after a fresh user prompt", async () => {
    const secondResetMs = RESET_MS + 180_000 + 10 * MINUTE_MS;
    const secondRecovered: QuotaWindowCollection = {
      binding: { kind: "account", sourceId: "account-1" },
      windows: [
        { key: "window:fiveHour", percentRemaining: 100, resetMs: secondResetMs + 60 * MINUTE_MS },
      ],
    };
    const { controller, prompt } = makeHarness({
      probes: [
        exhausted(),
        recovered(),
        recovered(),
        {
          binding: { kind: "account", sourceId: "account-1" },
          windows: [{ key: "window:fiveHour", percentRemaining: 0, resetMs: secondResetMs }],
        },
        secondRecovered,
        secondRecovered,
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(RESET_MS - NOW_MS + 60_000);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();

    // The execution started by that prompt fails on quota: no second auto-resume.
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(prompt).toHaveBeenCalledOnce();

    // A fresh user prompt starts a new execution, which may earn one auto-resume again.
    controller.onPrompt({ sessionID: SESSION_ID, metadata: {} });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(secondResetMs - (RESET_MS + 180_000) + 60_000);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("does not arm for a subagent session", async () => {
    const { controller, probe } = makeHarness({ info: sessionInfo({ parentID: "parent-1" }) });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not arm when the session is not failed", async () => {
    const { controller, probe } = makeHarness({ info: sessionInfo({ outcome: "succeeded" }) });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it("cancels a pending resume when the user submits a prompt", async () => {
    const { controller, prompt } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    controller.onPrompt({ sessionID: SESSION_ID, metadata: {} });
    await flushTimers(RESET_MS - NOW_MS + 60_000 + QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps the pending resume for its own prompt marker", async () => {
    const { controller, prompt } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    controller.onPrompt({
      sessionID: SESSION_ID,
      metadata: { source: QUOTA_AUTO_RESUME_SOURCE },
    });
    await flushTimers(RESET_MS - NOW_MS + 60_000 + QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("cancels on interruption, resume, model switch, deletion and credential changes", async () => {
    const cases: QuotaAutoResumeEvent[] = [
      {
        type: "session.execution.interrupted",
        data: { sessionID: SESSION_ID, reason: "user" },
      },
      { type: "session.execution.started", data: { sessionID: SESSION_ID } },
      {
        type: "session.model.selected",
        data: { sessionID: SESSION_ID, model: { id: "other", providerID: "other" } },
      },
      { type: "session.deleted", data: { sessionID: SESSION_ID } },
      { type: "credential.switched", data: { integrationID: "zai-coding-plan" } },
    ];
    for (const event of cases) {
      const { controller, prompt } = makeHarness();
      controller.handleEvent(failedEvent());
      await flushTimers(0);
      controller.handleEvent(event);
      await flushTimers(RESET_MS - NOW_MS + 60_000 + QUOTA_AUTO_RESUME_GRACE_MS);
      expect(prompt, event.type).not.toHaveBeenCalled();
    }
  });

  it("does not fire when the session stopped being failed at the grace boundary", async () => {
    const { controller, prompt, info } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(RESET_MS - NOW_MS + 60_000);
    info.outcome = "succeeded";
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not fire when the idle time changed", async () => {
    const { controller, prompt, info } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(RESET_MS - NOW_MS + 60_000);
    info.time = { idle: NOW_MS + 1 };
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("fires at most once per armed cycle", async () => {
    const { controller, prompt } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(RESET_MS - NOW_MS + 60_000 + QUOTA_AUTO_RESUME_GRACE_MS);
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("drops pending timers on dispose", async () => {
    const { controller, prompt } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    controller.dispose();
    await flushTimers(RESET_MS - NOW_MS + 60_000 + QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });
});
