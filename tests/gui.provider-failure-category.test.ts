/**
 * Structured provider-failure provenance. Categories must come from provider
 * source knowledge, survive projection/serialization unchanged, and never be
 * inferred from display text.
 */
import { describe, expect, it } from "vitest";
import type { ProviderCard } from "../src/contracts/dashboard.js";
import { isQuotaSnapshot } from "../src/contracts/dto-guards.js";
import { buildProviderCards, type ProviderCardPreferences } from "../src/gui/provider-cards.js";
import { sanitizeQuotaToastError } from "../src/lib/display-sanitize.js";
import { normalizeQuotaProviderResult } from "../src/lib/quota-state-codec.js";
import {
  attemptedErrorResult,
  mapNullableProviderResult,
} from "../src/providers/result-helpers.js";
import { parseQuotaSnapshot } from "../src/ui/dashboard-client.js";

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const SUMMARY: ProviderCardPreferences = { accountingDetail: "summary" };

describe("provider failure category provenance", () => {
  it("carries a category from result helpers without changing retryability", () => {
    const attempted = attemptedErrorResult("Provider", "API failed", {
      retryable: true,
      failureCategory: "provider_api",
    });
    const mapped = mapNullableProviderResult(
      {
        success: false as const,
        error: "sign-in missing",
        failureCategory: "credentials" as const,
      },
      {
        errorLabel: "Provider",
        onSuccess: () => ({ attempted: true, entries: [], errors: [] }),
      },
    );

    expect(attempted.errors[0]).toEqual({
      label: "Provider",
      message: "API failed",
      retryable: true,
      failureCategory: "provider_api",
    });
    expect(mapped.errors[0]?.failureCategory).toBe("credentials");
  });

  it("preserves the category and account attribution through card projection", () => {
    const cards = buildProviderCards({
      probes: [
        {
          providerId: "openai",
          result: {
            attempted: true,
            entries: [],
            accounts: [{ sourceId: "acct-1", label: "Work account" }],
            errors: [
              {
                label: "OpenAI",
                message: "Request failed",
                sourceId: "acct-1",
                failureCategory: "provider_api",
              },
            ],
          },
        },
      ],
      preferences: SUMMARY,
      nowMs: NOW,
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]?.accountLabel).toBe("Work account");
    expect(cards[0]?.errors).toEqual([
      {
        label: "OpenAI",
        message: "Request failed",
        failureCategory: "provider_api",
      },
    ]);
  });

  it("preserves source attribution and category through sanitization", () => {
    expect(
      sanitizeQuotaToastError({
        label: "Provider",
        message: "Request failed",
        retryable: true,
        kind: "intentional-filter",
        sourceId: "acct-1",
        failureCategory: "provider_api",
      }),
    ).toEqual({
      label: "Provider",
      message: "Request failed",
      retryable: true,
      kind: "intentional-filter",
      sourceId: "acct-1",
      failureCategory: "provider_api",
    });
  });

  it("accepts only known categories in persisted provider results", () => {
    const base = {
      attempted: true,
      entries: [],
      errors: [
        {
          label: "Provider",
          message: "Request failed",
          failureCategory: "provider_api",
        },
      ],
    };

    expect(normalizeQuotaProviderResult(base)?.errors[0]?.failureCategory).toBe("provider_api");
    expect(
      normalizeQuotaProviderResult({
        ...base,
        errors: [{ ...base.errors[0], failureCategory: "text-guess" }],
      }),
    ).toBeNull();
  });

  it("preserves the category across the dashboard DTO boundary", () => {
    const card: ProviderCard = {
      cardId: "openai:test" as ProviderCard["cardId"],
      providerId: "openai",
      providerLabel: "OpenAI",
      labelSource: "provider",
      rows: [],
      errors: [
        {
          label: "OpenAI",
          message: "Request failed",
          failureCategory: "provider_api",
        },
      ],
    };
    const snapshot = {
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers: { cards: [card], enabledProviders: "auto", polledAtMs: NOW },
    };

    expect(isQuotaSnapshot(snapshot)).toBe(true);
    expect(parseQuotaSnapshot(snapshot).providers.cards[0]?.errors[0]?.failureCategory).toBe(
      "provider_api",
    );
    expect(
      isQuotaSnapshot({
        ...snapshot,
        providers: {
          ...snapshot.providers,
          cards: [
            {
              ...card,
              errors: [{ label: "OpenAI", message: "Request failed", failureCategory: "guess" }],
            },
          ],
        },
      }),
    ).toBe(false);
  });
});
