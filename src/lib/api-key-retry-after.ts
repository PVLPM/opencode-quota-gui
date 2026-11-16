import { createHmac, randomBytes } from "node:crypto";

export function retryAfterDeadline(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const now = Date.now();
  const header = response.headers.get("retry-after")?.trim();
  const deadline =
    header && /^\d+$/.test(header)
      ? now + Number(header) * 1000
      : header && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)
        ? Date.parse(header)
        : NaN;
  return Number.isSafeInteger(deadline) && deadline > now ? deadline : undefined;
}

/** Guard one API-key provider's direct requests without retaining credentials. */
export function createApiKeyRetryGuard<T extends { success: boolean; retryAtMs?: number }>(
  blocked: (retryAtMs: number) => T,
): (
  key: string,
  request: () => Promise<T>,
  timeout?: number,
  blockedOverride?: (retryAtMs: number) => T,
  requestIdentity?: string,
) => Promise<T> {
  const secret = randomBytes(32);
  const deadlines = new Map<string, number>();
  const inFlight = new Map<string, { request: Promise<T>; timeout?: number }>();
  return async function runGuarded(key, request, timeout, blockedOverride, requestIdentity) {
    const cooldownIdentity = createHmac("sha256", secret)
      .update("cooldown\0")
      .update(key)
      .digest("base64url");
    const inFlightIdentity = createHmac("sha256", secret)
      .update("request\0")
      .update(JSON.stringify([key, requestIdentity ?? key]))
      .digest("base64url");
    const now = Date.now();
    for (const [id, deadline] of deadlines) if (deadline <= now) deadlines.delete(id);
    const deadline = deadlines.get(cooldownIdentity);
    if (deadline !== undefined) return (blockedOverride ?? blocked)(deadline);
    const pending = inFlight.get(inFlightIdentity);
    if (pending) {
      if (pending.timeout === timeout) return structuredClone(await pending.request);
      await pending.request;
      if (inFlight.get(inFlightIdentity) === pending) inFlight.delete(inFlightIdentity);
      return runGuarded(key, request, timeout, blockedOverride, requestIdentity);
    }
    const run = (async () => {
      const result = await request();
      if (!result.success && result.retryAtMs !== undefined && result.retryAtMs > Date.now()) {
        deadlines.set(cooldownIdentity, result.retryAtMs);
      }
      return result;
    })();
    const current = { request: run, timeout };
    inFlight.set(inFlightIdentity, current);
    try {
      return await run;
    } finally {
      if (inFlight.get(inFlightIdentity) === current) inFlight.delete(inFlightIdentity);
    }
  };
}
