import { describe, expect, it } from "vitest";

import {
  CACHE_OBSERVER_MAX_INVOCATIONS,
  type CacheInvocationObservation,
  type CacheRouteProvenance,
  classifyCacheObserverState,
  createCacheObserverState,
  observeCacheCompactionBoundary,
  observeCacheInvalidation,
  observeCacheInvocation,
  setCacheTtlEvidence,
} from "../src/lib/cache-observer.js";

const route: CacheRouteProvenance = {
  providerId: "anthropic",
  modelId: "claude-test",
  variantId: "fast",
  protocolId: "anthropic-messages",
  basis: { source: "opencode-message-metadata", reference: "msg-1" },
};

function stateFor(sessionId = "ses-parent") {
  return createCacheObserverState({ sessionId, route });
}

function invocation(
  overrides: Partial<CacheInvocationObservation> = {},
): CacheInvocationObservation {
  return {
    sessionId: "ses-parent",
    order: { completedAtMs: 100, messageId: "msg-1" },
    route,
    primaryClassification: {
      kind: "primary",
      basis: { source: "existing-runtime-classifier", reference: "msg-1" },
    },
    counts: { fresh: 20, read: 80, write: 10 },
    ...overrides,
  };
}

function withActiveTtl(state = stateFor(), expiresAtMs = 500) {
  return setCacheTtlEvidence(state, {
    kind: "configured",
    protocolId: "anthropic-messages",
    route,
    configuredTtlMs: 300_000,
    expiresAtMs,
    basis: { source: "anthropic-messages", reference: "accepted-5m-cache-ttl" },
  });
}

describe("observer-only cache state", () => {
  it("stays insufficient without observations, but a primary cache write establishes a prefix", () => {
    const empty = classifyCacheObserverState(stateFor(), 200);
    expect(empty.color).toBe("gray");

    const written = observeCacheInvocation(
      withActiveTtl(),
      invocation({ counts: { fresh: 20, read: 0, write: 10 } }),
    );
    const writtenClassification = classifyCacheObserverState(written, 200);
    expect(writtenClassification).toMatchObject({
      color: "green",
      reason: "observed-write-with-active-ttl",
      confidence: "best-effort",
      ttlSemantics: "configured-minimum",
      configuredTtlMs: 300_000,
      configuredTtlDeadlineAtMs: 500,
    });
    expect(writtenClassification).not.toHaveProperty("verifiedExpiresAtMs");
    expect(writtenClassification.primaryCacheReadRatio).toBeUndefined();
    expect(writtenClassification).not.toHaveProperty("warmingEnabled");
  });

  it("turns green only for an observed cache read with matching supported configured TTL", () => {
    const state = observeCacheInvocation(withActiveTtl(), invocation());

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "green",
      reason: "observed-reuse-with-active-ttl",
      confidence: "best-effort",
      ttlSemantics: "configured-minimum",
      configuredTtlDeadlineAtMs: 500,
      primaryCacheReadRatio: {
        value: 80 / 110,
        messageId: "msg-1",
        numerator: "cache-read",
        denominator: "fresh+read+write",
      },
    });
  });

  it("allows best-effort green without an impossible invalidation-coverage horizon", () => {
    const withTtl = setCacheTtlEvidence(stateFor(), {
      kind: "configured",
      protocolId: "anthropic-messages",
      route,
      configuredTtlMs: 300_000,
      expiresAtMs: 500,
      basis: { source: "anthropic-messages", reference: "accepted-5m-cache-ttl" },
    });
    const state = observeCacheInvocation(withTtl, invocation());

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "green",
      reason: "observed-reuse-with-active-ttl",
      confidence: "best-effort",
      ttlSemantics: "configured-minimum",
    });
  });

  it("does not accept a configured TTL unless the exact supported protocol and route match", () => {
    const unsupportedProtocol = setCacheTtlEvidence(stateFor(), {
      kind: "configured",
      protocolId: "anthropic-messages",
      route: { ...route, protocolId: undefined },
      configuredTtlMs: 300_000,
      expiresAtMs: 500,
      basis: { source: "anthropic-messages", reference: "accepted-5m-cache-ttl" },
    });
    const state = observeCacheInvocation(unsupportedProtocol, invocation());

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "yellow",
      reason: "ttl-unverified",
    });
  });

  it("does not establish reusable evidence from a non-primary or unclassified invocation", () => {
    const nonPrimary = observeCacheInvocation(
      withActiveTtl(),
      invocation({
        primaryClassification: {
          kind: "not-primary",
          basis: { source: "existing-runtime-classifier", reference: "msg-1" },
        },
      }),
    );
    const ambiguous = observeCacheInvocation(
      withActiveTtl(),
      invocation({
        primaryClassification: {
          kind: "unknown",
          basis: { source: "existing-runtime-classifier", reference: "msg-1" },
        },
      }),
    );

    expect(classifyCacheObserverState(nonPrimary, 200).color).toBe("gray");
    expect(classifyCacheObserverState(ambiguous, 200)).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
    });
  });

  it("does not keep an old green status after a newer relevant invocation is ambiguous", () => {
    let state = observeCacheInvocation(withActiveTtl(), invocation());
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 150, messageId: "msg-uncertain" },
        primaryClassification: {
          kind: "unknown",
          basis: { source: "existing-runtime-classifier", reference: "msg-uncertain" },
        },
      }),
    );

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
    });
  });

  it("does not leave an older prefix green after a newer primary invocation reports no read or write", () => {
    let state = observeCacheInvocation(withActiveTtl(), invocation());
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 150, messageId: "msg-no-cache-activity" },
        counts: { fresh: 100, read: 0, write: 0 },
      }),
    );

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
    });
  });

  it("treats a newer primary invocation with unknown route provenance as ambiguous", () => {
    let state = observeCacheInvocation(withActiveTtl(), invocation());
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 150, messageId: "msg-route-unknown" },
        route: undefined,
        counts: { fresh: 20, read: 0, write: 10 },
      }),
    );

    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
    });
  });

  it("matches route identity by observed provider/model while retaining each message's basis", () => {
    const secondMessageRoute: CacheRouteProvenance = {
      ...route,
      basis: { source: "opencode-message-metadata", reference: "msg-2" },
    };
    const state = observeCacheInvocation(
      withActiveTtl(),
      invocation({
        order: { completedAtMs: 120, messageId: "msg-2" },
        route: secondMessageRoute,
      }),
    );

    expect(classifyCacheObserverState(state, 200).color).toBe("green");
  });

  it("uses yellow, not green or red, when TTL is unverified or expired", () => {
    const observed = observeCacheInvocation(stateFor(), invocation());
    const unverified = setCacheTtlEvidence(observed, {
      kind: "unknown",
      basis: "ttl-not-observed",
    });
    const expired = withActiveTtl(observed, 100);

    expect(classifyCacheObserverState(unverified, 200).color).toBe("yellow");
    expect(classifyCacheObserverState(expired, 200).color).toBe("yellow");
  });

  it("uses red only for an explicit route-scoped invalidation after the observed reuse", () => {
    const observed = observeCacheInvocation(withActiveTtl(), invocation());
    const invalidated = observeCacheInvalidation(observed, {
      sessionId: "ses-parent",
      route,
      order: { completedAtMs: 150, messageId: "invalidate-1" },
      basis: { source: "host-invalidation-metadata", reference: "invalidate-1" },
    });

    expect(classifyCacheObserverState(invalidated, 200).color).toBe("red");
    expect(classifyCacheObserverState(withActiveTtl(), 200).color).not.toBe("red");

    const noPreviousPrefix = observeCacheInvalidation(withActiveTtl(), {
      sessionId: "ses-parent",
      route,
      order: { completedAtMs: 150, messageId: "invalidate-without-prefix" },
      basis: { source: "host-invalidation-metadata", reference: "invalidate-without-prefix" },
    });
    expect(classifyCacheObserverState(noPreviousPrefix, 200).color).not.toBe("red");

    const writtenPrefix = observeCacheInvocation(
      withActiveTtl(),
      invocation({ counts: { fresh: 20, read: 0, write: 10 } }),
    );
    const invalidatedWrite = observeCacheInvalidation(writtenPrefix, {
      sessionId: "ses-parent",
      route,
      order: { completedAtMs: 150, messageId: "invalidate-after-write" },
      basis: { source: "host-invalidation-metadata", reference: "invalidate-after-write" },
    });
    expect(classifyCacheObserverState(invalidatedWrite, 200).color).toBe("red");
  });

  it("reports host cache-read ratios from positive counters without protocol identity", () => {
    let state = withActiveTtl();
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 100, messageId: "msg-primary-old" },
        counts: { fresh: 10, read: 10, write: 0 },
      }),
    );
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 120, messageId: "msg-supplementary" },
        primaryClassification: {
          kind: "not-primary",
          basis: { source: "existing-runtime-classifier", reference: "msg-supplementary" },
        },
        counts: { fresh: 99, read: 0, write: 1 },
      }),
    );
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 130, messageId: "msg-primary-last" },
        counts: { fresh: 20, read: 60, write: 20 },
      }),
    );

    const classified = classifyCacheObserverState(state, 200);
    expect(classified.primaryCacheReadRatio).toMatchObject({
      value: 0.6,
      messageId: "msg-primary-last",
    });

    const missingWrite = observeCacheInvocation(
      withActiveTtl(),
      invocation({ counts: { fresh: 10, read: 10 } }),
    );
    expect(classifyCacheObserverState(missingWrite, 200).primaryCacheReadRatio).toBeUndefined();

    const missingFresh = observeCacheInvocation(
      withActiveTtl(),
      invocation({ counts: { read: 10, write: 10 } }),
    );
    const zeroDenominator = observeCacheInvocation(
      withActiveTtl(),
      invocation({ counts: { fresh: 0, read: 0, write: 0 } }),
    );
    expect(classifyCacheObserverState(missingFresh, 200).primaryCacheReadRatio).toBeUndefined();
    expect(classifyCacheObserverState(zeroDenominator, 200).primaryCacheReadRatio).toBeUndefined();

    const normalizedZero = observeCacheInvocation(
      withActiveTtl(),
      invocation({ counts: { fresh: 20, read: 80, write: 0 } }),
    );
    expect(classifyCacheObserverState(normalizedZero, 200).primaryCacheReadRatio).toBeUndefined();

    const nonAnthropicRoute: CacheRouteProvenance = {
      ...route,
      providerId: "openai",
      modelId: "gpt-test",
      protocolId: undefined,
    };
    const nonAnthropic = createCacheObserverState({
      sessionId: "ses-parent",
      route: nonAnthropicRoute,
    });
    const nonAnthropicState = observeCacheInvocation(
      nonAnthropic,
      invocation({ route: nonAnthropicRoute }),
    );
    expect(classifyCacheObserverState(nonAnthropicState, 200)).toMatchObject({
      color: "yellow",
      reason: "ttl-unverified",
      primaryCacheReadRatio: {
        value: 0.7272727272727273,
        messageId: "msg-1",
        numerator: "cache-read",
        denominator: "fresh+read+write",
      },
    });
  });

  it("exposes the conservative configured-TTL deadline without claiming physical eviction", () => {
    const state = observeCacheInvocation(withActiveTtl(), invocation());
    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "green",
      configuredTtlMs: 300_000,
      configuredTtlDeadlineAtMs: 500,
      confidence: "best-effort",
      ttlSemantics: "configured-minimum",
      recheckAtMs: 500,
      primaryCacheReadRatio: {
        observedAtMs: 100,
      },
    });
    const ttlExpired = classifyCacheObserverState(state, 500);
    expect(ttlExpired).toMatchObject({
      color: "yellow",
      reason: "ttl-expired",
    });
    expect(ttlExpired).not.toHaveProperty("configuredTtlDeadlineAtMs");
  });

  it("uses the host completion-time and message-id ordering, not arrival order", () => {
    let state = withActiveTtl();
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 100, messageId: "msg-z" },
        route: { ...route, basis: { ...route.basis, reference: "msg-z" } },
        counts: { fresh: 70, read: 20, write: 10 },
      }),
    );
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 100, messageId: "msg-a" },
        route: { ...route, basis: { ...route.basis, reference: "msg-a" } },
        counts: { fresh: 10, read: 90, write: 0 },
      }),
    );

    expect(classifyCacheObserverState(state, 200).primaryCacheReadRatio).toMatchObject({
      value: 0.2,
      messageId: "msg-z",
    });
  });

  it("withholds the last-primary ratio when a later invocation's primary classification is uncertain", () => {
    let state = withActiveTtl();
    state = observeCacheInvocation(state, invocation());
    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 150, messageId: "msg-unknown" },
        primaryClassification: {
          kind: "unknown",
          basis: { source: "existing-runtime-classifier", reference: "not-classified" },
        },
      }),
    );

    expect(classifyCacheObserverState(state, 200).primaryCacheReadRatio).toBeUndefined();
  });

  it("does not carry reusable evidence across an observed compaction boundary", () => {
    let state = observeCacheInvocation(withActiveTtl(), invocation());
    state = observeCacheCompactionBoundary(state, {
      sessionId: "ses-parent",
      order: { completedAtMs: 140, messageId: "compact-1" },
      basis: { source: "opencode-compaction-marker", reference: "compact-1" },
    });

    expect(classifyCacheObserverState(state, 200).color).toBe("yellow");

    state = observeCacheInvocation(
      state,
      invocation({
        order: { completedAtMs: 150, messageId: "msg-after-compact" },
        counts: { fresh: 20, read: 0, write: 10 },
      }),
    );
    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "green",
      reason: "observed-write-with-active-ttl",
    });
  });

  it("keeps session ownership separate and retains a bounded, ordered invocation window", () => {
    expect(() =>
      observeCacheInvocation(stateFor(), invocation({ sessionId: "ses-child" })),
    ).toThrow();

    let state = withActiveTtl();
    for (let index = 0; index < CACHE_OBSERVER_MAX_INVOCATIONS + 3; index += 1) {
      state = observeCacheInvocation(
        state,
        invocation({
          order: { completedAtMs: 100 + index, messageId: `msg-${index}` },
          counts: { fresh: 20, read: index + 1, write: 10 },
        }),
      );
    }

    expect(state.invocations).toHaveLength(CACHE_OBSERVER_MAX_INVOCATIONS);
    expect(classifyCacheObserverState(state, 200).primaryCacheReadRatio?.messageId).toBe(
      `msg-${CACHE_OBSERVER_MAX_INVOCATIONS + 2}`,
    );
  });

  it("reports uncertainty rather than gray when truncation removes the established prefix", () => {
    let state = observeCacheInvocation(withActiveTtl(), invocation());
    for (let index = 0; index < CACHE_OBSERVER_MAX_INVOCATIONS; index += 1) {
      state = observeCacheInvocation(
        state,
        invocation({
          order: { completedAtMs: 200 + index, messageId: `msg-nonprimary-${index}` },
          primaryClassification: {
            kind: "not-primary",
            basis: { source: "existing-runtime-classifier", reference: `msg-nonprimary-${index}` },
          },
          counts: { fresh: 0, read: 0, write: 0 },
        }),
      );
    }

    expect(state.invocations).toHaveLength(CACHE_OBSERVER_MAX_INVOCATIONS);
    expect(classifyCacheObserverState(state, 200)).toMatchObject({
      color: "yellow",
      reason: "history-truncated",
    });
  });
});
