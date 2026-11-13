import { describe, expect, it } from "vitest";

import {
  CACHE_OBSERVER_MAX_INVOCATIONS,
  type CacheInvocationObservation,
  type CacheRouteProvenance,
  cacheConfiguredTtlMsFromHostValue,
  classifyCacheObserverState,
  createCacheObserverState,
  observeCacheInvocation,
  openAiDocumentedTtlMs,
} from "../src/lib/cache-observer.js";

const route: CacheRouteProvenance = {
  providerId: "anthropic",
  modelId: "claude-test",
  variantId: "fast",
  protocolId: "anthropic-messages",
  basis: { source: "opencode-message-metadata", reference: "msg-1" },
};

const basis = { source: "successful-primary-step", reference: "msg-1" };

function stateFor(sessionId = "ses-parent", scopeRoute: CacheRouteProvenance = route) {
  return createCacheObserverState({ sessionId, route: scopeRoute });
}

/** A successful, eligible primary request: dispatch at 100 ms, completed at 100 ms. */
function invocation(
  overrides: Partial<CacheInvocationObservation> = {},
): CacheInvocationObservation {
  return {
    sessionId: "ses-parent",
    order: { completedAtMs: 100, messageId: "msg-1" },
    dispatchAtMs: 100,
    route,
    basis,
    counts: { fresh: 20, read: 80, write: 10 },
    ...overrides,
  };
}

function routeOf(providerId: string, modelId: string): CacheRouteProvenance {
  return { providerId, modelId, basis: { source: "opencode-message-metadata", reference: "m" } };
}

/** A state whose newest successful call is `overrides` on the given route. */
function observed(
  scopeRoute: CacheRouteProvenance,
  overrides: Partial<CacheInvocationObservation> = {},
) {
  return observeCacheInvocation(
    stateFor("ses-parent", scopeRoute),
    invocation({ route: scopeRoute, ...overrides }),
  );
}

describe("primary cache-read ratio", () => {
  it("reports a valid zero read when fresh and write telemetry are present", () => {
    const state = observeCacheInvocation(
      stateFor(),
      invocation({ counts: { fresh: 20, read: 0, write: 10 } }),
    );

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      primaryCacheReadRatio: { value: 0, messageId: "msg-1" },
      primaryCacheReadTelemetry: "available",
    });
  });

  it("accepts a positive read when fresh and write counters are legitimately zero", () => {
    const state = observeCacheInvocation(
      stateFor(),
      invocation({ counts: { fresh: 0, read: 80, write: 0 } }),
    );

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      primaryCacheReadRatio: { value: 1, messageId: "msg-1" },
      primaryCacheReadTelemetry: "available",
    });
  });

  it("does not fabricate a ratio from normalized all-zero counters", () => {
    const state = observeCacheInvocation(
      stateFor(),
      invocation({ counts: { fresh: 0, read: 0, write: 0 } }),
    );

    expect(classifyCacheObserverState(state, 200)).not.toHaveProperty("primaryCacheReadRatio");
    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      primaryCacheReadTelemetry: "unavailable",
    });
  });

  it("reports missing telemetry as unavailable when any counter is absent", () => {
    const state = observeCacheInvocation(
      stateFor(),
      invocation({ counts: { read: 80, write: 0 } }),
    );

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      primaryCacheReadTelemetry: "unavailable",
    });
    expect(classifyCacheObserverState(state, 200)).not.toHaveProperty("primaryCacheReadRatio");
  });

  it("computes the share from fresh+read+write independently of the estimate's route policy", () => {
    const openai = routeOf("openai", "gpt-6.1");
    const state = observed(openai, { counts: { fresh: 20, read: 80, write: 0 } });

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      primaryCacheReadRatio: {
        value: 0.8,
        numerator: "cache-read",
        denominator: "fresh+read+write",
      },
    });
  });

  it("suppresses an older ratio when the newest successful call has no usable counters", () => {
    let state = observeCacheInvocation(stateFor(), invocation());
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 150, messageId: "msg-zero" },
        counts: { fresh: 0, read: 0, write: 0 },
      }),
    );

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      primaryCacheReadTelemetry: "unavailable",
    });
    expect(classifyCacheObserverState(state, 200)).not.toHaveProperty("primaryCacheReadRatio");
  });
});

describe("retention estimate origin and colors", () => {
  it("stays gray with insufficient evidence until a successful eligible call exists", () => {
    expect(classifyCacheObserverState(stateFor(), 200)).toEqual({
      color: "gray",
      reason: "insufficient-evidence",
    });
  });

  it("starts the estimate at request start for a cache write as well as a read", () => {
    const state = observeCacheInvocation(
      stateFor(),
      invocation({ counts: { fresh: 20, read: 0, write: 10 } }),
    );

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "green",
      reason: "estimated-write-within-ttl",
      recheckAtMs: 240_100,
      ttlEstimate: {
        kind: "documented",
        ttlMs: 300_000,
        dispatchAtMs: 100,
        deadlineAtMs: 300_100,
      },
    });
  });

  it("keeps the request start as the origin for a successful call with no cache activity", () => {
    const state = observeCacheInvocation(
      stateFor(),
      invocation({ counts: { fresh: 100, read: 0, write: 0 } }),
    );

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "green",
      reason: "estimated-within-ttl",
      ttlEstimate: { deadlineAtMs: 300_100 },
    });
  });

  it("is green before 80% of the TTL, yellow in the final 20%, and red once expired", () => {
    const state = observeCacheInvocation(stateFor(), invocation());

    expect(classifyCacheObserverState(state, 240_099).color).toBe("green");
    expect(classifyCacheObserverState(state, 240_100)).toMatchObject({
      color: "yellow",
      reason: "estimated-ttl-near-expiry",
      recheckAtMs: 300_100,
    });
    expect(classifyCacheObserverState(state, 300_099).color).toBe("yellow");
    expect(classifyCacheObserverState(state, 300_100)).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
    });
  });

  it("measures a long successful call from its request start, not its completion", () => {
    // Dispatched at 100 and completed at 290_100: the 5-minute window is already
    // anchored to the start, so the call's completion does not extend it.
    const state = observeCacheInvocation(
      stateFor(),
      invocation({ order: { completedAtMs: 290_100, messageId: "msg-long" } }),
    );

    expect(classifyCacheObserverState(state, 240_100)).toMatchObject({
      color: "yellow",
      ttlEstimate: { dispatchAtMs: 100, deadlineAtMs: 300_100 },
    });
    expect(classifyCacheObserverState(state, 300_100)).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
    });
  });

  it("renews the estimate from a newer request start, not from completion time", () => {
    let state = observeCacheInvocation(stateFor(), invocation());
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 250_100, messageId: "msg-2" },
        dispatchAtMs: 250_000,
        counts: { fresh: 100, read: 0, write: 0 },
      }),
    );

    expect(classifyCacheObserverState(state, 300_200)).toMatchObject({
      color: "green",
      ttlEstimate: { dispatchAtMs: 250_000, deadlineAtMs: 550_000 },
    });
  });

  it("applies the host-configured 1-hour TTL with 80/20 boundaries on Anthropic", () => {
    const state = observed(route);
    const config = { configuredTtlMs: 3_600_000 as const };

    expect(classifyCacheObserverState(state, 300_100, config)).toMatchObject({
      color: "green",
      ttlEstimate: { kind: "configured", ttlMs: 3_600_000, deadlineAtMs: 3_600_100 },
    });
    expect(classifyCacheObserverState(state, 2_880_100, config)).toMatchObject({
      color: "yellow",
      reason: "estimated-ttl-near-expiry",
      recheckAtMs: 3_600_100,
    });
    expect(classifyCacheObserverState(state, 3_600_100, config)).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
    });
  });

  it("applies the host-configured 1-hour TTL to a Kimi route", () => {
    const kimi = routeOf("moonshotai", "kimi-k2");
    const state = observed(kimi);

    expect(
      classifyCacheObserverState(state, 300_100, { configuredTtlMs: 3_600_000 }),
    ).toMatchObject({
      color: "green",
      ttlEstimate: { kind: "configured", ttlMs: 3_600_000, deadlineAtMs: 3_600_100 },
    });
  });

  it("keeps the documented 5-minute Kimi default when no TTL is configured", () => {
    const kimi = routeOf("moonshotai", "kimi-k2");

    expect(classifyCacheObserverState(observed(kimi), 200)).toMatchObject({
      color: "green",
      ttlEstimate: { kind: "documented", ttlMs: 300_000 },
    });
  });

  it("ignores a configured TTL on a route without a supported configuration", () => {
    const other = routeOf("deepseek", "deepseek-chat");

    expect(
      classifyCacheObserverState(observed(other), 200, { configuredTtlMs: 3_600_000 }),
    ).toMatchObject({
      color: "green",
      ttlEstimate: { kind: "empirical", ttlMs: 86_400_000 },
    });
  });

  it("parses only supported host cache.ttl values", () => {
    expect(cacheConfiguredTtlMsFromHostValue("5m")).toBe(300_000);
    expect(cacheConfiguredTtlMsFromHostValue("300s")).toBe(300_000);
    expect(cacheConfiguredTtlMsFromHostValue("1h")).toBe(3_600_000);
    expect(cacheConfiguredTtlMsFromHostValue("60m")).toBe(3_600_000);
    expect(cacheConfiguredTtlMsFromHostValue("24h")).toBeUndefined();
    expect(cacheConfiguredTtlMsFromHostValue("30m")).toBeUndefined();
    expect(cacheConfiguredTtlMsFromHostValue("soon")).toBeUndefined();
    expect(cacheConfiguredTtlMsFromHostValue(3_600_000)).toBeUndefined();
    expect(cacheConfiguredTtlMsFromHostValue(undefined)).toBeUndefined();
  });

  it("uses the documented 5-minute default for direct Anthropic without configuration", () => {
    expect(classifyCacheObserverState(observed(route), 200)).toMatchObject({
      color: "green",
      ttlEstimate: { kind: "documented", ttlMs: 300_000 },
    });
  });

  it("applies the empirical 24-hour estimate to direct DeepSeek", () => {
    const deepseek = routeOf("deepseek", "deepseek-chat");

    expect(classifyCacheObserverState(observed(deepseek), 200)).toMatchObject({
      color: "green",
      ttlEstimate: {
        kind: "empirical",
        ttlMs: 86_400_000,
        dispatchAtMs: 100,
        deadlineAtMs: 86_400_100,
      },
    });
  });

  it("applies the empirical 60-minute estimate only to OpenCode Go deepseek-v4.1-flash", () => {
    expect(
      classifyCacheObserverState(observed(routeOf("opencode-go", "deepseek-v4.1-flash")), 200),
    ).toMatchObject({ color: "green", ttlEstimate: { kind: "empirical", ttlMs: 3_600_000 } });
    expect(
      classifyCacheObserverState(observed(routeOf("opencode-go", "other")), 200),
    ).toMatchObject({ color: "green", ttlEstimate: { kind: "fallback", ttlMs: 300_000 } });
  });

  it("does not infer vendor retention for gateway routes", () => {
    expect(
      classifyCacheObserverState(
        observed(routeOf("openrouter", "deepseek/deepseek-v4.1-flash")),
        200,
      ),
    ).toMatchObject({ color: "green", ttlEstimate: { kind: "fallback", ttlMs: 300_000 } });
  });

  it("gives OpenAI-family routes the generic 5-minute fallback, not a gray state", () => {
    for (const providerId of ["openai", "chatgpt", "codex"]) {
      expect(
        classifyCacheObserverState(observed(routeOf(providerId, "gpt-6.1")), 200),
      ).toMatchObject({
        color: "green",
        ttlEstimate: { kind: "fallback", ttlMs: 300_000, deadlineAtMs: 300_100 },
      });
    }
  });

  it("stays gray with dispatch-time-unavailable when request start is absent", () => {
    const state = observeCacheInvocation(stateFor(), invocation({ dispatchAtMs: undefined }));

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "gray",
      reason: "dispatch-time-unavailable",
    });
  });

  it("stays gray with route-unverified when the newest successful call lacks route provenance", () => {
    const state = observeCacheInvocation(stateFor(), invocation({ route: undefined }));

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "gray",
      reason: "route-unverified",
    });
  });

  it("does not expose confidence, verified-expiry, or TTL-semantics labels", () => {
    const classification = classifyCacheObserverState(observed(route), 200);

    expect(classification).not.toHaveProperty("confidence");
    expect(classification).not.toHaveProperty("verifiedExpiresAtMs");
    expect(classification).not.toHaveProperty("ttlSemantics");
  });
});

describe("OpenAI model-specific lifetime", () => {
  const direct = { directOpenAiApi: true };
  const openai = (modelId: string) => routeOf("openai", modelId);

  it("identifies the documented 30-minute families by model id", () => {
    for (const modelId of [
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6",
      "gpt-5.7",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
    ]) {
      expect(openAiDocumentedTtlMs(modelId)).toBe(1_800_000);
    }
    for (const modelId of ["gpt-5.4", "gpt-5.5-codex", "gpt-5.1", "gpt-4.1", "o4-mini", "gpt-5"]) {
      expect(openAiDocumentedTtlMs(modelId)).toBeUndefined();
    }
  });

  it("applies the documented 30-minute lifetime on a confirmed direct API route, with 80/20 boundaries", () => {
    const state = observed(openai("gpt-6.1-sol"));

    expect(classifyCacheObserverState(state, 200, direct)).toMatchObject({
      color: "green",
      ttlEstimate: {
        kind: "documented",
        ttlMs: 1_800_000,
        dispatchAtMs: 100,
        deadlineAtMs: 1_800_100,
      },
    });
    expect(classifyCacheObserverState(state, 1_440_100, direct)).toMatchObject({
      color: "yellow",
      reason: "estimated-ttl-near-expiry",
    });
    expect(classifyCacheObserverState(state, 1_800_100, direct)).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
    });
  });

  it("keeps the generic 5-minute fallback when the route is not confirmed as direct", () => {
    expect(classifyCacheObserverState(observed(openai("gpt-6.1-sol")), 200)).toMatchObject({
      color: "green",
      ttlEstimate: { kind: "fallback", ttlMs: 300_000 },
    });
  });

  it("does not apply the OpenAI lifetime to a model without one or to ChatGPT-family providers", () => {
    expect(classifyCacheObserverState(observed(openai("gpt-5.4")), 200, direct)).toMatchObject({
      ttlEstimate: { kind: "fallback", ttlMs: 300_000 },
    });
    expect(
      classifyCacheObserverState(observed(routeOf("chatgpt", "gpt-6.1-sol")), 200, direct),
    ).toMatchObject({ ttlEstimate: { kind: "fallback", ttlMs: 300_000 } });
  });
});

describe("observer state boundaries", () => {
  it("orders invocations by completion time and message id, not arrival order", () => {
    let state = observeCacheInvocation(
      stateFor(),
      invocation({
        order: { completedAtMs: 200, messageId: "msg-b" },
        dispatchAtMs: 150,
      }),
    );
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 100, messageId: "msg-a" },
        dispatchAtMs: 10,
      }),
    );

    expect(classifyCacheObserverState(state, 300)).toMatchObject({
      ttlEstimate: { dispatchAtMs: 150 },
    });
  });

  it("rejects evidence from another session or route", () => {
    expect(() =>
      observeCacheInvocation(stateFor(), invocation({ sessionId: "ses-child" })),
    ).toThrow(TypeError);
    expect(() =>
      observeCacheInvocation(
        stateFor(),
        invocation({ route: { providerId: "anthropic", modelId: "other", basis } }),
      ),
    ).toThrow(TypeError);
  });

  it("retains a bounded, ordered invocation window", () => {
    let state = stateFor();
    for (let index = 0; index <= CACHE_OBSERVER_MAX_INVOCATIONS; index += 1) {
      state = observeCacheInvocation(
        state,
        invocation({
          order: { completedAtMs: 100 + index, messageId: `msg-${index}` },
          dispatchAtMs: 100 + index,
        }),
      );
    }

    expect(state.invocations).toHaveLength(CACHE_OBSERVER_MAX_INVOCATIONS);
    expect(state.invocations.at(-1)?.order.messageId).toBe(`msg-${CACHE_OBSERVER_MAX_INVOCATIONS}`);
  });
});
