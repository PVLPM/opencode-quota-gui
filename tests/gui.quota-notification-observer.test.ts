/**
 * Host-side quota notification observation.
 *
 * One observer per shared host sees every fresh quota source cycle exactly
 * once. Detection state (rows/providers) is memory-only and silently baselines
 * on startup or a source handoff; only the returned cooldown fingerprints are
 * persisted through the existing private atomic JSON write. Delivery is the
 * separate dashboard `quotaNotification` event: live-only, best effort, and
 * silently lost when no window is listening.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProviderCard,
  QuotaCardRow,
  QuotaSnapshot,
  SettingsSnapshot,
} from "../src/contracts/dashboard.js";
import type { CardId, RowId } from "../src/contracts/identity.js";
import {
  createQuotaNotificationObserver,
  type QuotaNotificationSettings,
  quotaNotificationSettingsFromSnapshot,
} from "../src/gui/quota-notification-observer.js";
import { writeJsonAtomic } from "../src/lib/atomic-json.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const RESET_AT = "2026-11-02T17:00:00.000Z";
const CARD_ID = `openai:${"a".repeat(64)}`;

const roots: string[] = [];

function makeStatePath(): string {
  const root = mkdtempSync(join(tmpdir(), "ocq-quota-notification-observer-"));
  roots.push(root);
  return join(root, "quota-notifications.json");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function row(percentRemaining: number, rowId = "row-1", resetAtIso = RESET_AT): QuotaCardRow {
  return {
    rowId: rowId as RowId,
    label: "5-hour window",
    kind: "percent",
    resultType: "quota",
    percentRemaining,
    resetAtIso,
  };
}

function card(options: {
  percentRemaining: number;
  cardId?: string;
  rowId?: string;
  resetAtIso?: string;
  errors?: ProviderCard["errors"];
}): ProviderCard {
  return {
    cardId: (options.cardId ?? CARD_ID) as CardId,
    providerId: "openai",
    providerLabel: "OpenAI",
    accountLabel: "work",
    labelSource: "account",
    rows: [row(options.percentRemaining, options.rowId, options.resetAtIso)],
    errors: options.errors ?? [],
  };
}

function snapshotOf(cards: ProviderCard[], stale = false): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale,
    timeZone: "UTC",
    providers: {
      cards,
      enabledProviders: "auto",
      polledAtMs: NOW,
    },
  };
}

function snapshot(
  percentRemaining: number,
  options: {
    stale?: boolean;
    cardId?: string;
    rowId?: string;
    resetAtIso?: string;
    errors?: ProviderCard["errors"];
  } = {},
): QuotaSnapshot {
  return snapshotOf([card({ percentRemaining, ...options })], options.stale);
}

/** One card with two independently crossing rows. */
function twoRowsSnapshot(percentRemaining: number): QuotaSnapshot {
  return snapshotOf([
    {
      ...card({ percentRemaining }),
      rows: [row(percentRemaining, "row-1"), row(percentRemaining, "row-2")],
    },
  ]);
}

function effectiveSettings(
  overrides: Partial<QuotaNotificationSettings> = {},
): QuotaNotificationSettings {
  return {
    lowThresholdPercent: 10,
    cooldownMs: 30 * 60_000,
    hiddenCards: [],
    hiddenRows: [],
    percentDisplayMode: "remaining",
    ...overrides,
  };
}

function createObserver(options: {
  statePath?: string;
  now?: () => number;
  settings?: QuotaNotificationSettings;
  loadSettings?: () => Promise<QuotaNotificationSettings>;
  writeState?: (statePath: string, cooldowns: Record<string, number>) => Promise<void>;
}) {
  const events: Array<
    Parameters<Parameters<ReturnType<typeof createQuotaNotificationObserver>["subscribe"]>[0]>[0]
  > = [];
  const observer = createQuotaNotificationObserver({
    statePath: options.statePath ?? makeStatePath(),
    now: options.now ?? (() => NOW),
    loadSettings: options.loadSettings ?? (async () => options.settings ?? effectiveSettings()),
    ...(options.writeState ? { writeState: options.writeState } : {}),
  });
  observer.subscribe((event) => events.push(event));
  return { observer, events };
}

function readState(statePath: string): { version: number; cooldowns: Record<string, number> } {
  return JSON.parse(readFileSync(statePath, "utf8")) as {
    version: number;
    cooldowns: Record<string, number>;
  };
}

function settingsSnapshot(values: Record<string, unknown>, visibility = {}): SettingsSnapshot {
  return {
    values,
    visibility: {
      hiddenCards: [],
      hiddenRows: [],
      ...(visibility as { hiddenCards?: string[]; hiddenRows?: string[] }),
    },
  } as unknown as SettingsSnapshot;
}

describe("quota notification observer", () => {
  it("baselines silently, then emits one safe event and persists only its cooldown", async () => {
    const statePath = makeStatePath();
    const { observer, events } = createObserver({ statePath });
    const shared: unknown[] = [];
    observer.subscribe((event) => shared.push(event));

    observer.observe(snapshot(50));
    await observer.flush();
    expect(events).toEqual([]);
    expect(existsSync(statePath)).toBe(false);

    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "low", title: "OpenAI quota low" });
    expect(events[0]?.id).toMatch(/^[a-f0-9]{64}:\d+$/);
    expect(events[0]?.description).toContain("work");
    expect(events[0]?.description).toContain("5-hour window");
    expect(events[0]?.description).toContain("5% remaining");
    expect(events[0]?.description).toContain(RESET_AT);
    // Every window receives the same identity (and the same value).
    expect(shared).toEqual([events[0]]);

    const persisted = readState(statePath);
    expect(Object.keys(persisted).sort()).toEqual(["cooldowns", "version"]);
    expect(persisted.version).toBe(1);
    expect(Object.values(persisted.cooldowns)).toEqual([NOW]);
    expect(Object.keys(persisted.cooldowns)[0]).toMatch(/^[a-f0-9]{64}$/);

    // Repeated identical cycles never replay the transition.
    observer.observe(snapshot(5));
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);
    await observer.close();
  });

  it("ignores stale snapshots and keeps the previous baseline", async () => {
    const { observer, events } = createObserver({});

    observer.observe(snapshot(50));
    await observer.flush();
    expect(events).toEqual([]);

    observer.observe(snapshot(5, { stale: true }));
    await observer.flush();
    expect(events).toEqual([]);

    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("low");
    await observer.close();

    // A stale first snapshot is not a baseline either.
    const fresh = createObserver({});
    fresh.observer.observe(snapshot(5, { stale: true }));
    await fresh.observer.flush();
    fresh.observer.observe(snapshot(5));
    await fresh.observer.flush();
    expect(fresh.events).toEqual([]);
    await fresh.observer.close();
  });

  it("honours hidden cards and rows from effective settings", async () => {
    const hiddenRow = createObserver({
      settings: effectiveSettings({ hiddenRows: ["row-1"] }),
    });
    hiddenRow.observer.observe(snapshot(50));
    hiddenRow.observer.observe(snapshot(5));
    await hiddenRow.observer.flush();
    expect(hiddenRow.events).toEqual([]);
    await hiddenRow.observer.close();

    const hiddenCard = createObserver({
      settings: effectiveSettings({ hiddenCards: [CARD_ID] }),
    });
    hiddenCard.observer.observe(snapshot(50));
    hiddenCard.observer.observe(snapshot(5));
    await hiddenCard.observer.flush();
    expect(hiddenCard.events).toEqual([]);
    await hiddenCard.observer.close();

    // The provider id is the normalized legacy hidden-card identity.
    const hiddenProvider = createObserver({
      settings: effectiveSettings({ hiddenCards: ["openai"] }),
    });
    hiddenProvider.observer.observe(snapshot(50));
    hiddenProvider.observer.observe(snapshot(5));
    await hiddenProvider.observer.flush();
    expect(hiddenProvider.events).toEqual([]);
    await hiddenProvider.observer.close();
  });

  it("fails closed when settings are unavailable and silently re-baselines on recovery", async () => {
    let calls = 0;
    const { observer, events } = createObserver({
      loadSettings: async () => {
        calls += 1;
        if (calls === 1) throw new Error("config unavailable");
        return effectiveSettings();
      },
    });

    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toEqual([]);

    // Recovery must not replay the value seen during the outage.
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toEqual([]);

    observer.observe(snapshot(50));
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);
    await observer.close();

    // A failure after a real baseline also discards that baseline.
    let fail = false;
    const later = createObserver({
      loadSettings: async () => {
        if (fail) throw new Error("config unavailable");
        return effectiveSettings();
      },
    });
    later.observer.observe(snapshot(50));
    await later.observer.flush();
    fail = true;
    later.observer.observe(snapshot(5));
    await later.observer.flush();
    expect(later.events).toEqual([]);
    fail = false;
    later.observer.observe(snapshot(5));
    await later.observer.flush();
    expect(later.events).toEqual([]);
    later.observer.observe(snapshot(50));
    later.observer.observe(snapshot(5));
    await later.observer.flush();
    expect(later.events).toHaveLength(1);
    await later.observer.close();
  });

  it("reports a proven provider error without leaking its label or message", async () => {
    const { observer, events } = createObserver({});
    const rawMessage = "provider body sk-secret-value";

    observer.observe(snapshot(50));
    observer.observe(
      snapshot(50, {
        errors: [{ label: "Provider API", message: rawMessage, failureCategory: "provider_api" }],
      }),
    );
    await observer.flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("provider-error");
    expect(events[0]?.title).toBe("OpenAI quota error");
    expect(events[0]?.description).not.toContain(rawMessage);
    expect(events[0]?.description).not.toContain("sk-secret-value");
    await observer.close();

    const unknown = createObserver({});
    unknown.observer.observe(snapshot(50));
    unknown.observer.observe(
      snapshot(50, {
        errors: [{ label: "Provider API", message: rawMessage, failureCategory: "credentials" }],
      }),
    );
    await unknown.observer.flush();
    expect(unknown.events).toEqual([]);
    await unknown.observer.close();
  });

  it("uses the canonical percent display mode for wording", async () => {
    const used = createObserver({
      settings: effectiveSettings({ percentDisplayMode: "used" }),
    });
    used.observer.observe(snapshot(50));
    used.observer.observe(snapshot(5));
    await used.observer.flush();
    expect(used.events[0]?.description).toContain("95% used");
    expect(used.events[0]?.description).not.toContain("remaining");
    await used.observer.close();

    const exhausted = createObserver({
      settings: effectiveSettings({ percentDisplayMode: "used" }),
    });
    exhausted.observer.observe(snapshot(50));
    exhausted.observer.observe(snapshot(0));
    await exhausted.observer.flush();
    expect(exhausted.events[0]?.description).toContain("100% used");
    await exhausted.observer.close();
  });

  it("gives a later threshold re-cross a distinct deterministic event id", async () => {
    let now = NOW;
    const { observer, events } = createObserver({ now: () => now });

    observer.observe(snapshot(50));
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);
    const firstId = events[0]?.id;

    now += 31 * 60_000;
    observer.observe(snapshot(50));
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(2);
    expect(events[1]?.id).not.toBe(firstId);
    expect(events[1]?.kind).toBe("low");
    await observer.close();
  });

  it("stops publishing when a listener hands the source off during delivery", async () => {
    const observer = createQuotaNotificationObserver({
      statePath: makeStatePath(),
      now: () => NOW,
      loadSettings: async () => effectiveSettings(),
    });
    const first = vi.fn(() => {
      observer.sourceChanged();
    });
    const second = vi.fn();
    observer.subscribe(first);
    observer.subscribe(second);

    observer.observe(twoRowsSnapshot(50));
    await observer.flush();
    observer.observe(twoRowsSnapshot(5));
    await observer.flush();

    // The first callback fences the rest of this event and every later
    // notification produced by the old source.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    await observer.close();
  });

  it("stops publishing when a listener closes the observer during delivery", async () => {
    const observer = createQuotaNotificationObserver({
      statePath: makeStatePath(),
      now: () => NOW,
      loadSettings: async () => effectiveSettings(),
    });
    let closing: Promise<void> | undefined;
    const first = vi.fn(() => {
      closing = observer.close();
    });
    const second = vi.fn();
    observer.subscribe(first);
    observer.subscribe(second);

    observer.observe(twoRowsSnapshot(50));
    await observer.flush();
    observer.observe(twoRowsSnapshot(5));
    await observer.flush();
    await closing;

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("resets the baseline on a source handoff but keeps persisted cooldowns", async () => {
    let now = NOW;
    const statePath = makeStatePath();
    const { observer, events } = createObserver({ statePath, now: () => now });

    observer.observe(snapshot(50));
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);

    observer.sourceChanged();
    // The first fresh snapshot under the replacement source is a silent
    // baseline, even though it is already below the threshold.
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);

    // A crossing inside the persisted cooldown is still suppressed.
    now += 60_000;
    observer.observe(snapshot(50));
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);

    // Once the cooldown expires, the same transition notifies again.
    now += 31 * 60_000;
    observer.observe(snapshot(50));
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(2);
    await observer.close();
  });

  it("treats malformed cooldown state as empty and survives a failed write", async () => {
    const statePath = makeStatePath();
    writeFileSync(statePath, "{not json", "utf8");
    const { observer, events } = createObserver({
      statePath,
      writeState: async () => {
        throw new Error("disk full");
      },
    });

    observer.observe(snapshot(50));
    observer.observe(snapshot(5));
    await observer.flush();
    // Persistence is best effort: the alert is not lost when the write fails.
    expect(events).toHaveLength(1);
    await observer.close();
  });

  it("persists through the existing atomic writer and merges readable cooldowns", async () => {
    const statePath = makeStatePath();
    await writeJsonAtomic(statePath, {
      version: 1,
      cooldowns: { "another-process-fingerprint": NOW - 1_000 },
    });
    const calls: Array<Record<string, number>> = [];
    const { observer, events } = createObserver({
      statePath,
      writeState: async (path, cooldowns) => {
        calls.push(cooldowns);
        await writeJsonAtomic(path, { version: 1, cooldowns });
      },
    });

    observer.observe(snapshot(50));
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveProperty("another-process-fingerprint");
    const persisted = readState(statePath);
    expect(Object.keys(persisted.cooldowns)).toHaveLength(2);
    await observer.close();
  });

  it("drops queued work after close", async () => {
    const { observer, events } = createObserver({});
    const pending = observer.flush();
    await pending;

    observer.observe(snapshot(50));
    await observer.flush();
    await observer.close();
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toEqual([]);
  });

  it("derives canonical settings and defaults from the settings snapshot", () => {
    const defaults = quotaNotificationSettingsFromSnapshot(settingsSnapshot({}));
    expect(defaults).toEqual({
      lowThresholdPercent: 10,
      cooldownMs: 30 * 60_000,
      hiddenCards: [],
      hiddenRows: [],
      percentDisplayMode: "remaining",
    });

    const configured = quotaNotificationSettingsFromSnapshot(
      settingsSnapshot(
        {
          lowQuotaThresholdRemainingPercent: 20,
          duplicateCooldownMinutes: 5,
          percentDisplayMode: "used",
        },
        { hiddenCards: ["openai"], hiddenRows: ["row-1"] },
      ),
    );
    expect(configured).toEqual({
      lowThresholdPercent: 20,
      cooldownMs: 5 * 60_000,
      hiddenCards: ["openai"],
      hiddenRows: ["row-1"],
      percentDisplayMode: "used",
    });

    expect(() =>
      quotaNotificationSettingsFromSnapshot(
        settingsSnapshot({ lowQuotaThresholdRemainingPercent: "high" }),
      ),
    ).toThrow(/config unavailable/u);
    expect(() =>
      quotaNotificationSettingsFromSnapshot(settingsSnapshot({ duplicateCooldownMinutes: -1 })),
    ).toThrow(/config unavailable/u);
    expect(() =>
      quotaNotificationSettingsFromSnapshot(settingsSnapshot({ percentDisplayMode: "percent" })),
    ).toThrow(/config unavailable/u);

    // Visibility is authoritative. Missing or malformed values must fail
    // closed; treating them as "nothing hidden" could alert a hidden card.
    expect(() =>
      quotaNotificationSettingsFromSnapshot({ values: {} } as unknown as SettingsSnapshot),
    ).toThrow(/config unavailable/u);
    expect(() =>
      quotaNotificationSettingsFromSnapshot({
        values: {},
        visibility: { hiddenCards: "openai", hiddenRows: [] },
      } as unknown as SettingsSnapshot),
    ).toThrow(/config unavailable/u);
    expect(() =>
      quotaNotificationSettingsFromSnapshot({
        values: {},
        visibility: { hiddenCards: [] },
      } as unknown as SettingsSnapshot),
    ).toThrow(/config unavailable/u);
    expect(() =>
      quotaNotificationSettingsFromSnapshot({
        values: {},
        visibility: { hiddenCards: [123], hiddenRows: [] },
      } as unknown as SettingsSnapshot),
    ).toThrow(/config unavailable/u);
    expect(() =>
      quotaNotificationSettingsFromSnapshot({
        values: {},
        visibility: { hiddenCards: [""], hiddenRows: [] },
      } as unknown as SettingsSnapshot),
    ).toThrow(/config unavailable/u);
  });

  it("drops a snapshot captured from the old source generation", async () => {
    const { observer, events } = createObserver({});

    observer.observe(snapshot(50));
    await observer.flush();
    const oldEpoch = observer.epoch();

    observer.sourceChanged();
    // The replacement source's first snapshot is the new silent baseline.
    observer.observe(snapshot(50));
    await observer.flush();

    // The old source read settles late; its captured epoch is stale.
    observer.observe(snapshot(5), oldEpoch);
    await observer.flush();
    expect(events).toEqual([]);

    // The new generation still classifies its own transition.
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("low");
    await observer.close();
  });

  it("fences a notification when the host hands off during the cooldown write", async () => {
    const statePath = makeStatePath();
    let now = NOW;
    let observerRef: ReturnType<typeof createQuotaNotificationObserver> | undefined;
    let writes = 0;
    const events: unknown[] = [];
    const observer = createQuotaNotificationObserver({
      statePath,
      now: () => now,
      loadSettings: async () => effectiveSettings(),
      writeState: async (path, cooldowns) => {
        writes += 1;
        // The source handoff lands while the first cooldown write is pending.
        if (writes === 1) observerRef?.sourceChanged();
        await writeJsonAtomic(path, { version: 1, cooldowns });
      },
    });
    observerRef = observer;
    observer.subscribe((event) => events.push(event));

    observer.observe(snapshot(50));
    await observer.flush();
    observer.observe(snapshot(5));
    await observer.flush();
    expect(writes).toBe(1);
    expect(events).toEqual([]);

    // The replacement generation re-baselines and still notifies later.
    now += 31 * 60_000;
    observer.observe(snapshot(50));
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toHaveLength(1);
    await observer.close();
  });

  it("does not emit from an empty or missing provider cycle", async () => {
    const { observer, events } = createObserver({});
    observer.observe(snapshot(50));
    await observer.flush();
    observer.observe(snapshotOf([]));
    await observer.flush();
    expect(events).toEqual([]);
    // Returning low after the row disappeared re-baselines instead of alerting.
    observer.observe(snapshot(5));
    await observer.flush();
    expect(events).toEqual([]);
    await observer.close();
  });

  it("serializes observations so overlapping cycles do not double classify", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { observer, events } = createObserver({
      loadSettings: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return effectiveSettings();
      },
    });

    observer.observe(snapshot(50));
    observer.observe(snapshot(5));
    await vi.waitFor(() => expect(calls).toBe(1));
    release?.();
    await observer.flush();
    expect(events).toHaveLength(1);
    await observer.close();
  });
});
