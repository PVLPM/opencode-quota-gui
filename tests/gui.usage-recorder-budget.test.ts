/**
 * Periodic budget rows with a scheduled reset join the usage history (D11).
 * A budget row without a valid scheduled reset is never recorded; quota and
 * rate_limit eligibility is unchanged.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderCard, QuotaCardRow, QuotaSnapshot } from "../src/contracts/dashboard.js";
import {
  markQuotaObservationCycle,
  markQuotaObservationLive,
} from "../src/gui/quota-observation.js";
import { createUsageRecorder } from "../src/gui/usage-recorder.js";
import { openUsageStore } from "../src/lib/usage-store.js";

const BASE = Date.parse("2026-06-01T00:00:00.000Z");
const MINUTE = 60_000;

let roots: string[] = [];
let recorders: ReturnType<typeof createUsageRecorder>[] = [];

beforeEach(() => {
  roots = [];
  recorders = [];
});

afterEach(async () => {
  for (const recorder of recorders.splice(0).reverse()) await recorder.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function budgetRow(overrides: Partial<QuotaCardRow> = {}): QuotaCardRow {
  return {
    rowId: "mistral:vibe#named:Vibe monthly budget",
    label: "Vibe monthly budget:",
    kind: "percent",
    resultType: "budget",
    percentRemaining: 62,
    resetAtIso: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function card(rows: QuotaCardRow[]): ProviderCard {
  return {
    cardId: "mistral:vibe" as ProviderCard["cardId"],
    providerId: "mistral",
    providerLabel: "Mistral Vibe",
    labelSource: "provider",
    rows,
    errors: [],
  };
}

function budgetSnapshot(row: QuotaCardRow): QuotaSnapshot {
  const value: QuotaSnapshot = {
    generatedAtMs: BASE,
    stale: false,
    timeZone: "UTC",
    providers: { cards: [card([row])], enabledProviders: "auto", polledAtMs: BASE },
  };
  markQuotaObservationCycle(value, {
    measuredAtByCard: new Map([["mistral:vibe", BASE]]),
    intervalMs: MINUTE,
    providerIds: ["mistral"],
  });
  return markQuotaObservationLive(value);
}

async function recordedRowIds(row: QuotaCardRow): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "ocq-usage-recorder-budget-"));
  roots.push(root);
  const path = join(root, "usage-history.sqlite");
  const recorder = createUsageRecorder({ path });
  recorders.push(recorder);
  recorder.observe(budgetSnapshot(row), 0);
  await recorder.flush();
  const store = await openUsageStore(path);
  try {
    return store
      .query({ startMs: 0, endMs: BASE + 24 * 60 * MINUTE })
      .series.map((item) => item.rowId);
  } finally {
    store.close();
  }
}

describe("usage recorder: periodic budget row eligibility", () => {
  it("records a budget row that has a scheduled reset, keeping its rowId", async () => {
    const row = budgetRow();
    const rowIds = await recordedRowIds(row);
    expect(rowIds).toEqual([row.rowId]);
  });

  it("does not record a budget row without a scheduled reset", async () => {
    const row = budgetRow({ resetAtIso: undefined });
    expect(await recordedRowIds(row)).toEqual([]);
  });

  it("does not record a budget row with an unparseable reset", async () => {
    const row = budgetRow({ resetAtIso: "not-a-timestamp" });
    expect(await recordedRowIds(row)).toEqual([]);
  });
});
