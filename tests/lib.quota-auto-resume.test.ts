import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createQuotaAutoResumption,
  QUOTA_AUTO_RESUME_GRACE_MS,
  QUOTA_AUTO_RESUME_PROMPT,
  QUOTA_AUTO_RESUME_SOURCE,
  type QuotaAutoResumeEvent,
  type QuotaAutoResumeProbe,
  type QuotaAutoResumeSessionInfo,
} from "../src/lib/quota-auto-resume.js";
import type { QuotaWindowCollection } from "../src/lib/quota-retry-wait.js";

const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE_MS = 60_000;
/** The controller's polling interval after an observation gap. */
const RETRY_MS = 60_000;
const RESET_MS = NOW_MS + 10 * MINUTE_MS;
const RESET_DELAY_MS = RESET_MS - NOW_MS;
const SESSION_ID = "session-1";
const MODEL = { id: "glm-4.6", providerID: "zai-coding-plan" };
const BINDING = { kind: "account", sourceId: "account-1" } as const;

function exhausted(resetMs = RESET_MS, percentRemaining = 0): QuotaWindowCollection {
  return {
    binding: BINDING,
    windows: [{ key: "window:fiveHour", percentRemaining, resetMs }],
  };
}

function available(resetMs = RESET_MS + 5 * 60 * MINUTE_MS): QuotaWindowCollection {
  return {
    binding: BINDING,
    windows: [{ key: "window:fiveHour", percentRemaining: 100, resetMs }],
  };
}

function recovered(): QuotaWindowCollection {
  return available();
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

type ProbeResult = QuotaWindowCollection | QuotaAutoResumeProbe | Error | undefined;

/** Wraps a harness probe answer in the controller's discriminated evidence state. */
function probeAnswer(result: ProbeResult): QuotaAutoResumeProbe {
  if (result === undefined) return { kind: "absent" };
  if (result instanceof Error) return { kind: "absent" };
  if ("kind" in result) return result;
  return { kind: "collection", collection: result };
}

function makeHarness(
  options: {
    probes?: ProbeResult[];
    /** Answer for probes after the queued ones are used. */
    probeFallback?: ProbeResult;
    infos?: Array<QuotaAutoResumeSessionInfo | Error>;
    info?: QuotaAutoResumeSessionInfo;
  } = {},
) {
  const probe = vi.fn();
  for (const result of options.probes ?? [exhausted(), recovered(), recovered()]) {
    if (result instanceof Error) probe.mockRejectedValueOnce(result);
    else probe.mockResolvedValueOnce(probeAnswer(result));
  }
  if ("probeFallback" in options) probe.mockResolvedValue(probeAnswer(options.probeFallback));
  const info = options.info ?? sessionInfo();
  const queuedInfos = [...(options.infos ?? [])];
  const get = vi.fn(async () => {
    const next = queuedInfos.shift();
    if (next === undefined) return info;
    if (next instanceof Error) throw next;
    return next;
  });
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

    // There is no extra buffer after the reset: the first recovery check lands on it.
    await flushTimers(RESET_DELAY_MS - 1);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(1);
    expect(probe).toHaveBeenCalledTimes(2);

    // The confirmed recovery starts the two-minute inactivity grace.
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

  it("honors a provider-requested wait later than the reset", async () => {
    const { controller, probe, prompt } = makeHarness();
    controller.handleEvent(failedEvent({ type: "provider.quota", retryAfterMs: 15 * MINUTE_MS }));
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(5 * MINUTE_MS - 1);
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(1);
    expect(probe).toHaveBeenCalledTimes(2);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps waiting when a different exhausted window still has a reset ahead", async () => {
    const laterResetMs = RESET_MS + 2 * MINUTE_MS;
    const bothRecovered: QuotaWindowCollection = {
      binding: BINDING,
      windows: [
        { key: "window:fiveHour", percentRemaining: 100, resetMs: RESET_MS + 5 * 60 * MINUTE_MS },
        {
          key: "window:weekly",
          percentRemaining: 100,
          resetMs: laterResetMs + 7 * 24 * 60 * MINUTE_MS,
        },
      ],
    };
    const { controller, prompt } = makeHarness({
      probes: [
        {
          binding: BINDING,
          windows: [
            { key: "window:fiveHour", percentRemaining: 0, resetMs: RESET_MS },
            { key: "window:weekly", percentRemaining: 0, resetMs: laterResetMs },
          ],
        },
        {
          binding: BINDING,
          windows: [
            {
              key: "window:fiveHour",
              percentRemaining: 100,
              resetMs: RESET_MS + 5 * 60 * MINUTE_MS,
            },
            // The weekly row has not refreshed its next boundary yet.
            { key: "window:weekly", percentRemaining: 0, resetMs: laterResetMs },
          ],
        },
        bothRecovered,
        bothRecovered,
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(laterResetMs - NOW_MS);
    expect(prompt).not.toHaveBeenCalled();
    // The stale weekly boundary is an incomplete observation, so the controller polls.
    await flushTimers(RETRY_MS);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS - 1);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(1);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps a pending resume when the exhausted window row is temporarily missing", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [
        exhausted(),
        {
          binding: BINDING,
          windows: [{ key: "window:weekly", percentRemaining: 100 }],
        },
        recovered(),
        recovered(),
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(3);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps a pending resume when a recovery observation loses its identity", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [
        exhausted(),
        {
          windows: [
            {
              key: "window:fiveHour",
              percentRemaining: 100,
              resetMs: RESET_MS + 5 * 60 * MINUTE_MS,
            },
          ],
        },
        recovered(),
        recovered(),
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(3);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("cancels when the active account changes", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [
        exhausted(),
        {
          binding: { kind: "account", sourceId: "account-2" },
          windows: [
            {
              key: "window:fiveHour",
              percentRemaining: 100,
              resetMs: RESET_MS + 5 * 60 * MINUTE_MS,
            },
          ],
        },
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps trying to arm after a temporary session read failure", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [exhausted(), recovered(), recovered()],
      infos: [new Error("rpc timeout"), sessionInfo(), sessionInfo(), sessionInfo(), sessionInfo()],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).not.toHaveBeenCalled();
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(RESET_DELAY_MS - RETRY_MS);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps a pending resume when the first quota observation is absent", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [undefined, exhausted(), recovered(), recovered()],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).toHaveBeenCalledOnce();
    // No baseline yet: the resume waits and polls instead of being cancelled.
    await flushTimers(RETRY_MS - 1);
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(1);
    expect(probe).toHaveBeenCalledTimes(2);
    await flushTimers(RESET_DELAY_MS - RETRY_MS);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps a pending resume when the first quota probe fails", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [new Error("rpc timeout"), exhausted(), recovered(), recovered()],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    await flushTimers(RESET_DELAY_MS - RETRY_MS);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("stops immediately when the setting is disabled", async () => {
    const { controller, probe, prompt } = makeHarness({ probes: [{ kind: "disabled" }] });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).toHaveBeenCalledOnce();
    // A disabled feature is never polled again.
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(probe).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("cancels a pending resume when the setting is disabled later", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [exhausted(), { kind: "disabled" }],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps a pending resume when a recovery probe fails temporarily", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [
        exhausted(),
        new Error("network"),
        new Error("rpc timeout"),
        recovered(),
        recovered(),
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(3);
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps a pending resume when the session read fails temporarily", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [exhausted(), recovered(), recovered()],
      infos: [sessionInfo(), new Error("rpc timeout"), sessionInfo(), sessionInfo(), sessionInfo()],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    // The read failed, so the recovery probe was not attempted and the resume was kept.
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps the confirmed grace when the final probe fails temporarily", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [exhausted(), recovered(), new Error("network"), recovered()],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("restarts the wait when the window is used up again during the grace", async () => {
    const secondResetMs = RESET_MS + 5 * 60 * MINUTE_MS;
    const { controller, prompt } = makeHarness({
      probes: [
        exhausted(),
        available(secondResetMs),
        exhausted(secondResetMs),
        available(secondResetMs + 5 * 60 * MINUTE_MS),
        available(secondResetMs + 5 * 60 * MINUTE_MS),
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    // The first recovery opened the grace, but the grace probe finds the window used up again.
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(secondResetMs - (RESET_MS + QUOTA_AUTO_RESUME_GRACE_MS));
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps the confirmed grace when the final session read fails", async () => {
    const { controller, prompt } = makeHarness({
      probes: [exhausted(), recovered(), recovered(), recovered()],
      infos: [
        sessionInfo(),
        sessionInfo(),
        sessionInfo(),
        new Error("rpc timeout"),
        sessionInfo(),
        sessionInfo(),
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(RETRY_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("does not accept a positive percentage without a reset transition", async () => {
    const stalePositive: QuotaWindowCollection = {
      binding: BINDING,
      windows: [{ key: "window:fiveHour", percentRemaining: 100, resetMs: RESET_MS }],
    };
    const { controller, probe, prompt } = makeHarness({
      probes: [exhausted()],
      probeFallback: stalePositive,
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS + QUOTA_AUTO_RESUME_GRACE_MS + 60 * MINUTE_MS);
    expect(probe.mock.calls.length).toBeGreaterThan(2);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps waiting while the window stays exhausted, then fires after the next reset", async () => {
    const secondResetMs = RESET_MS + 5 * MINUTE_MS;
    const { controller, prompt } = makeHarness({
      probes: [
        exhausted(),
        exhausted(secondResetMs),
        available(secondResetMs + 5 * 60 * MINUTE_MS),
        available(secondResetMs + 5 * 60 * MINUTE_MS),
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(5 * MINUTE_MS);
    expect(prompt).not.toHaveBeenCalled();
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("does not arm for Claude Agent's untyped five-hour limit", async () => {
    const { controller, probe, prompt } = makeHarness();
    // OpenCode 2.4.1 reports this as an unknown provider error with only a message.
    controller.handleEvent(
      failedEvent({
        type: "provider.unknown",
        message: "Claude Code subscription limit reached (five hour). Resets at 4:20pm.",
      }),
    );
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(probe).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("arms the baseline from the first used-up observation with a reset", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [
        exhausted(RESET_MS, 40),
        { binding: BINDING, windows: [{ key: "window:fiveHour", percentRemaining: 0 }] },
        exhausted(),
        recovered(),
        recovered(),
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).toHaveBeenCalledOnce();
    // An available window and a used-up window without a boundary cannot prove a reset.
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(3);
    await flushTimers(RESET_DELAY_MS - 2 * RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(4);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps polling when a used-up window has no stable identity", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [
        {
          binding: BINDING,
          windows: [{ percentRemaining: 0, resetMs: RESET_MS }],
        },
        exhausted(),
        recovered(),
        recovered(),
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    await flushTimers(RESET_DELAY_MS - RETRY_MS);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps polling until the failed route has a verified identity", async () => {
    const { controller, probe, prompt } = makeHarness({
      probes: [
        {
          windows: [{ key: "window:fiveHour", percentRemaining: 0, resetMs: RESET_MS }],
        },
        exhausted(),
        recovered(),
        recovered(),
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(RETRY_MS - 1);
    expect(probe).toHaveBeenCalledOnce();
    await flushTimers(1);
    expect(probe).toHaveBeenCalledTimes(2);
    await flushTimers(RESET_DELAY_MS - RETRY_MS);
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("does not arm again after its own continue execution fails", async () => {
    const { controller, probe, prompt } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
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
    const secondResetMs = RESET_MS + 3 * MINUTE_MS + 10 * MINUTE_MS;
    const { controller, prompt } = makeHarness({
      probes: [
        exhausted(),
        recovered(),
        recovered(),
        exhausted(secondResetMs),
        available(secondResetMs + 5 * 60 * MINUTE_MS),
        available(secondResetMs + 5 * 60 * MINUTE_MS),
      ],
    });
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
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
    await flushTimers(secondResetMs - (RESET_MS + QUOTA_AUTO_RESUME_GRACE_MS));
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
    await flushTimers(RESET_DELAY_MS + QUOTA_AUTO_RESUME_GRACE_MS);
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
    await flushTimers(RESET_DELAY_MS + QUOTA_AUTO_RESUME_GRACE_MS);
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
      await flushTimers(RESET_DELAY_MS + QUOTA_AUTO_RESUME_GRACE_MS);
      expect(prompt, event.type).not.toHaveBeenCalled();
    }
  });

  it("does not fire when the session stopped being failed at the grace boundary", async () => {
    const { controller, prompt, info } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    info.outcome = "succeeded";
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not fire when the idle time changed", async () => {
    const { controller, prompt, info } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS);
    info.time = { idle: NOW_MS + 1 };
    await flushTimers(QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("fires at most once per armed cycle", async () => {
    const { controller, prompt } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    await flushTimers(RESET_DELAY_MS + QUOTA_AUTO_RESUME_GRACE_MS);
    await flushTimers(24 * 60 * MINUTE_MS);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("drops pending timers on dispose", async () => {
    const { controller, prompt } = makeHarness();
    controller.handleEvent(failedEvent());
    await flushTimers(0);
    controller.dispose();
    await flushTimers(RESET_DELAY_MS + QUOTA_AUTO_RESUME_GRACE_MS);
    expect(prompt).not.toHaveBeenCalled();
  });
});
