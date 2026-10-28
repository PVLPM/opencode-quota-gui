import type { CostBuckets } from "./modelsdev-pricing.js";

export interface TokenBucketLike {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}

type TokenBucketKey = keyof TokenBucketLike;

function perToken(usdPer1M?: number): number {
  return typeof usdPer1M === "number" ? usdPer1M / 1_000_000 : 0;
}

/**
 * Rate for one token bucket, including only the documented fallbacks:
 * cache read/write to input, reasoning to output. `undefined` means the entry
 * has no authoritative rate for that bucket.
 */
export function rateForTokenBucket(rates: CostBuckets, bucket: TokenBucketKey): number | undefined {
  switch (bucket) {
    case "input":
      return rates.input;
    case "output":
      return rates.output;
    case "cache_read":
      return rates.cache_read ?? rates.input;
    case "cache_write":
      return rates.cache_write ?? rates.input;
    case "reasoning":
      return rates.reasoning ?? rates.output;
  }
}

/**
 * Split positive token buckets by whether an applicable rate exists. Missing
 * base input/output rates are not zero; explicit zero rates count as known.
 */
export type TokenRateCoverage = {
  /** Positive tokens in buckets with an applicable rate. */
  pricedTokens: number;
  /** Positive tokens in buckets with no applicable rate. */
  unpricedTokens: number;
};

export function tokenRateCoverage(rates: CostBuckets, tokens: TokenBucketLike): TokenRateCoverage {
  let pricedTokens = 0;
  let unpricedTokens = 0;
  for (const bucket of ["input", "output", "cache_read", "cache_write", "reasoning"] as const) {
    const count = tokens[bucket];
    if (!(count > 0)) continue;
    if (typeof rateForTokenBucket(rates, bucket) === "number") {
      pricedTokens += count;
    } else {
      unpricedTokens += count;
    }
  }
  return { pricedTokens, unpricedTokens };
}

/**
 * Split token counts into the buckets that can be priced and the buckets that
 * have no applicable rate. Explicit zero rates count as priced; missing rates
 * do not. Consumers that can only report one complete number use this to avoid
 * charging unpriced tokens at zero.
 */
export function splitTokenBucketsByRate(
  rates: CostBuckets,
  tokens: TokenBucketLike,
): { priced: TokenBucketLike; unpriced: TokenBucketLike } {
  const priced: TokenBucketLike = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
  };
  const unpriced: TokenBucketLike = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
  };

  for (const bucket of ["input", "output", "cache_read", "cache_write", "reasoning"] as const) {
    const count = tokens[bucket];
    if (!(count > 0)) continue;
    if (typeof rateForTokenBucket(rates, bucket) === "number") {
      priced[bucket] = count;
    } else {
      unpriced[bucket] = count;
    }
  }

  return { priced, unpriced };
}

export function calculateUsdFromTokenBuckets(rates: CostBuckets, tokens: TokenBucketLike): number {
  return (
    tokens.input * perToken(rateForTokenBucket(rates, "input")) +
    tokens.output * perToken(rateForTokenBucket(rates, "output")) +
    tokens.cache_read * perToken(rateForTokenBucket(rates, "cache_read")) +
    tokens.cache_write * perToken(rateForTokenBucket(rates, "cache_write")) +
    tokens.reasoning * perToken(rateForTokenBucket(rates, "reasoning"))
  );
}
