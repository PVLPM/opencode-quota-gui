import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SettingsSnapshot } from "../src/contracts/dashboard.js";
import type {
  TemporalModelInterval,
  TemporalModelStatus,
  TemporalProviderStatus,
  TemporalStatusSnapshot,
  TemporalWeekday,
  TemporalWeeklySchedule,
} from "../src/contracts/temporal.js";
import {
  combineTemporalPhases,
  describeTemporalSchedule,
  formatLocalInterval,
  formatTemporalHoliday,
  groupTemporalModels,
  isCurrentTemporalHoliday,
  nearestTemporalHoliday,
  temporalEffectVaries,
  temporalModelNextChange,
} from "../src/ui/temporal-format.js";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import { settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
const appSource = readFileSync(path.join(repoRoot, "src/ui/app.tsx"), "utf8");
const quotaViewSource = readFileSync(path.join(repoRoot, "src/ui/views/home.tsx"), "utf8");
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FUTURE_HOLIDAY_START = Date.parse("2026-11-15T16:00:00.000Z");
const FUTURE_HOLIDAY_END = Date.parse("2026-11-18T16:00:00.000Z");

interface SsrGraph {
  renderToString: (fn: () => unknown) => string;
  createComponent: (component: unknown, props: unknown) => unknown;
  load: (path: string) => Promise<Record<string, unknown>>;
}

let server: ViteDevServer | undefined;
let graph: SsrGraph;

const tooltipBoundary = {
  name: "tooltip-ssr-boundary",
  enforce: "pre" as const,
  transform(_code: string, id: string) {
    if (id.replaceAll("\\", "/").endsWith("/overlays/tooltip/tooltip.tsx")) {
      return "export function Tooltip(props) { return props.children }";
    }
  },
};

beforeAll(async () => {
  const created = await createServer({
    configFile: false,
    root: path.join(repoRoot, "src/ui"),
    plugins: [tooltipBoundary, solid({ include: [...SOLID_JSX_SOURCES], ssr: true })],
    resolve: {
      dedupe: ["solid-js", "solid-js/web", "solid-js/store", "@solidjs/meta"],
    },
    ssr: { noExternal: ["@opencode/ui"] },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  server = created;
  const web = (await created.ssrLoadModule("solid-js/web")) as {
    renderToString: SsrGraph["renderToString"];
  };
  const core = (await created.ssrLoadModule("solid-js")) as {
    createComponent: SsrGraph["createComponent"];
  };
  graph = {
    renderToString: web.renderToString,
    createComponent: core.createComponent,
    load: (modulePath) => created.ssrLoadModule(modulePath) as Promise<Record<string, unknown>>,
  };
}, 60_000);

afterAll(async () => {
  await server?.close();
});

async function renderView(modulePath: string, exportName: string, props: unknown): Promise<string> {
  const module = await graph.load(modulePath);
  const component = module[exportName];
  if (typeof component !== "function") {
    throw new Error(`${modulePath} does not export ${exportName}`);
  }
  return graph.renderToString(() => graph.createComponent(component, props));
}

/** Solid SSR inserts hydration comments between adjacent text nodes. */
function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/\s+/g, " ");
}

function model(
  modelId: string,
  state: "peak" | "offpeak" | "unknown",
  factor?: number,
): TemporalModelStatus {
  const effect =
    factor === undefined
      ? undefined
      : {
          factor,
          direction: state === "peak" ? ("peak" as const) : ("offpeak" as const),
          unit: "api_price" as const,
        };
  return {
    modelId,
    state,
    ...(effect ? { effect } : {}),
    nextChangeAtMs: NOW + 2 * HOUR,
    intervals: [
      {
        startMs: NOW - HOUR,
        endMs: NOW + 2 * HOUR,
        phase: state,
        ...(effect ? { effect } : {}),
      },
      {
        startMs: NOW + 2 * HOUR,
        endMs: NOW + 5 * HOUR,
        phase: state === "peak" ? "offpeak" : "peak",
        ...(effect
          ? {
              effect: {
                ...effect,
                factor: 1 / effect.factor,
                direction: state === "peak" ? ("offpeak" as const) : ("peak" as const),
              },
            }
          : {}),
      },
    ],
  };
}

function provider(
  providerId: string,
  providerLabel: string,
  models: TemporalModelStatus[],
  phase: TemporalProviderStatus["phase"],
  discovered = true,
): TemporalProviderStatus {
  return {
    providerId,
    providerLabel,
    discovered,
    phase,
    models,
    holidays: [
      {
        jurisdiction: "CN",
        id: "spring-festival",
        localStart: "2026-11-16",
        localEnd: "2026-11-19",
        startMs: FUTURE_HOLIDAY_START,
        endMs: FUTURE_HOLIDAY_END,
      },
    ],
  };
}

const deepseek = provider("deepseek", "DeepSeek", [model("deepseek-v4-pro", "peak", 2)], "peak");
const mixed = provider(
  "test-mixed",
  "Test Mixed",
  [model("peak-model", "peak", 2), model("offpeak-model", "offpeak", 0.5)],
  "mixed",
);
const zai = {
  ...provider(
    "zai",
    "Z.ai",
    [
      {
        ...model("glm-5", "peak", 2),
        effect: { factor: 2, direction: "peak", unit: "quota_points" },
        nextState: "offpeak",
        intervals: [
          {
            startMs: NOW - HOUR,
            endMs: NOW + 2 * HOUR,
            phase: "peak",
            effect: { factor: 2, direction: "peak", unit: "quota_points" },
          },
        ],
      },
    ],
    "peak",
    true,
  ),
  source: {
    label: "Z.ai current credits-plan usage",
    url: "https://docs.z.ai/devpack/overview#usage-instruction",
    accessedAt: "2026-10-30",
  },
};

function temporal(): TemporalStatusSnapshot {
  return {
    generatedAtMs: NOW,
    providers: [deepseek, mixed, zai],
    snapshot: { revision: "4a58d0bc74552942a2aa29bc9065a38ed3fe04e4", generatedAtMs: NOW },
  };
}

function temporalWithNoAccount(): TemporalStatusSnapshot {
  const snapshot = temporal();
  return {
    ...snapshot,
    providers: [
      ...snapshot.providers,
      provider("google", "Google", [model("gemini-3-pro", "offpeak", 0.5)], "offpeak", false),
    ],
  };
}

function temporalSettings(overrides: Record<string, boolean> = {}): SettingsSnapshot {
  const base = settingsSnapshot();
  return {
    ...base,
    values: {
      ...base.values,
      "dashboard.temporalProviderOverrides": overrides,
    },
    writable: [...base.writable, "dashboard.temporalProviderOverrides"],
  };
}

/** Seven UTC days: off-peak base, Mon–Fri 14:00–18:00 peak, weekends off-peak. */
function weekModel(startIso = "2026-11-02T00:00:00.000Z"): TemporalModelStatus {
  const start = Date.parse(startIso);
  const offpeak = {
    factor: 1,
    direction: "unchanged" as const,
    unit: "api_price" as const,
  };
  const peak = { factor: 2, direction: "peak" as const, unit: "api_price" as const };
  const intervals: TemporalModelInterval[] = [];
  for (let day = 0; day < 7; day += 1) {
    const dayStart = start + day * DAY;
    const dayEnd = dayStart + DAY;
    const weekday = new Date(dayStart).getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      intervals.push(
        { startMs: dayStart, endMs: dayStart + 14 * HOUR, phase: "offpeak", effect: offpeak },
        {
          startMs: dayStart + 14 * HOUR,
          endMs: dayStart + 18 * HOUR,
          phase: "peak",
          effect: peak,
        },
        { startMs: dayStart + 18 * HOUR, endMs: dayEnd, phase: "offpeak", effect: offpeak },
      );
    } else {
      intervals.push({ startMs: dayStart, endMs: dayEnd, phase: "offpeak", effect: offpeak });
    }
  }
  return { modelId: "weekly-model", state: "offpeak", effect: offpeak, intervals };
}

const MON_FRI: TemporalWeekday[] = ["mon", "tue", "wed", "thu", "fri"];
const ALL_DAYS: TemporalWeekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const OFFPEAK_UNCHANGED = {
  factor: 1,
  direction: "unchanged" as const,
  unit: "api_price" as const,
};
const PEAK_2X = { factor: 2, direction: "peak" as const, unit: "api_price" as const };

function deepSeekWeekly(): TemporalWeeklySchedule {
  return {
    timeZone: "UTC",
    utcOffsetMinutes: 0,
    basePhase: "offpeak",
    baseEffect: { ...OFFPEAK_UNCHANGED },
    windows: [
      {
        days: MON_FRI,
        startMinute: 60,
        endMinute: 240,
        phase: "peak",
        effect: { ...PEAK_2X },
      },
      {
        days: MON_FRI,
        startMinute: 360,
        endMinute: 600,
        phase: "peak",
        effect: { ...PEAK_2X },
      },
    ],
    exceptHolidays: ["CN"],
  };
}

function weeklyModel(
  weekly: TemporalWeeklySchedule,
  overrides: Partial<TemporalModelStatus> = {},
): TemporalModelStatus {
  return {
    modelId: "weekly-model",
    state: "offpeak",
    effect: { ...OFFPEAK_UNCHANGED },
    intervals: [
      {
        startMs: NOW - HOUR,
        endMs: NOW + HOUR,
        phase: "offpeak",
        effect: { ...OFFPEAK_UNCHANGED },
      },
    ],
    weekly,
    ...overrides,
  };
}

describe("temporal formatting helpers", () => {
  it("resolves the clock from the zone: Istanbul 24-hour, US 12-hour", () => {
    const start = Date.parse("2026-11-02T11:00:00.000Z");
    const end = Date.parse("2026-11-02T14:00:00.000Z");
    const istanbul = formatLocalInterval(start, end, {
      locale: "tr-TR",
      timeZone: "Europe/Istanbul",
    });
    // The browser locale must not force a 12-hour clock on Istanbul.
    const enUsIstanbul = formatLocalInterval(start, end, {
      locale: "en-US",
      timeZone: "Europe/Istanbul",
    });
    expect(istanbul).toContain("14:00");
    expect(istanbul).not.toContain("PM");
    expect(enUsIstanbul).toContain("14:00");
    expect(enUsIstanbul).not.toContain("2:00 PM");

    const enUsNewYork = formatLocalInterval(start, end, {
      locale: "en-US",
      timeZone: "America/New_York",
    });
    expect(enUsNewYork).toContain("6:00 AM");
    expect(enUsNewYork).not.toContain("06:00");
    expect(enUsNewYork).not.toContain("14:00");

    // An IANA alias normalizes to a US zone and keeps the 12-hour clock.
    const alias = formatLocalInterval(start, end, {
      locale: "en-US",
      timeZone: "US/Eastern",
    });
    expect(alias).toContain("6:00 AM");
    expect(alias).not.toContain("14:00");
  });

  it("uses the nearest holiday's actual instants and omits jurisdiction, names and lists", () => {
    const older = {
      jurisdiction: "CN" as const,
      id: "older",
      localStart: "2026-10-01",
      localEnd: "2026-10-02",
      startMs: Date.parse("2026-10-01T16:00:00.000Z"),
      endMs: Date.parse("2026-10-02T16:00:00.000Z"),
    };
    const nearest = {
      jurisdiction: "CN" as const,
      id: "spring-festival",
      localStart: "2026-11-16",
      localEnd: "2026-11-19",
      startMs: FUTURE_HOLIDAY_START,
      endMs: FUTURE_HOLIDAY_END,
    };
    expect(nearestTemporalHoliday([older, nearest], NOW)?.id).toBe("spring-festival");
    const text = formatTemporalHoliday(nearest, {
      locale: "en-GB",
      timeZone: "Europe/Istanbul",
    });
    expect(text).toContain("19:00");
    expect(text).toMatch(/11\/15|15\/11|15\.11/);
    expect(text).not.toContain("Nov");
    expect(text).not.toContain("CN");
    expect(text).not.toContain("spring");
    expect(isCurrentTemporalHoliday(nearest, FUTURE_HOLIDAY_START + HOUR)).toBe(true);
    expect(isCurrentTemporalHoliday(nearest, FUTURE_HOLIDAY_START - HOUR)).toBe(false);
    expect(isCurrentTemporalHoliday(nearest, FUTURE_HOLIDAY_END)).toBe(false);
  });

  it("never infers a weekly recurrence without a server descriptor", () => {
    // Seven observed days are still only a sample; no descriptor means the
    // browser cannot claim a recurrence or model holiday weeks.
    const schedule = describeTemporalSchedule(weekModel(), Date.parse("2026-11-02T00:00:00Z"));
    expect(schedule.kind).toBe("dates");
    expect(schedule.intervals.length).toBeGreaterThan(0);
  });

  it("renders a declared UTC weekly schedule in Istanbul local time", () => {
    const schedule = describeTemporalSchedule(
      weeklyModel(deepSeekWeekly()),
      Date.parse("2027-01-11T12:00:00Z"),
      { timeZone: "Europe/Istanbul", locale: "en-US" },
    );
    expect(schedule.kind).toBe("weekly");
    if (schedule.kind !== "weekly") return;
    expect(schedule.basePhase).toBe("offpeak");
    expect(schedule.windows).toEqual([
      { days: MON_FRI, startMinute: 240, endMinute: 420, phase: "peak", effect: PEAK_2X },
      { days: MON_FRI, startMinute: 540, endMinute: 780, phase: "peak", effect: PEAK_2X },
    ]);
    expect(schedule.effectVaries).toBe(true);
  });

  it("renders Z.ai's Singapore weekly schedule in Istanbul local time", () => {
    const weekly: TemporalWeeklySchedule = {
      timeZone: "Asia/Singapore",
      utcOffsetMinutes: 480,
      basePhase: "offpeak",
      baseEffect: { factor: 0.5, direction: "offpeak", unit: "quota_points" },
      windows: [
        {
          days: MON_FRI,
          startMinute: 840,
          endMinute: 1080,
          phase: "peak",
          effect: { factor: 1, direction: "peak", unit: "quota_points" },
        },
      ],
    };
    const schedule = describeTemporalSchedule(
      weeklyModel(weekly),
      Date.parse("2027-01-11T12:00:00Z"),
      { timeZone: "Europe/Istanbul", locale: "en-US" },
    );
    expect(schedule.kind).toBe("weekly");
    if (schedule.kind !== "weekly") return;
    expect(schedule.windows).toEqual([
      {
        days: MON_FRI,
        startMinute: 540,
        endMinute: 780,
        phase: "peak",
        effect: { factor: 1, direction: "peak", unit: "quota_points" },
      },
    ]);
    expect(schedule.basePhase).toBe("offpeak");
  });

  it("splits a source window that crosses local midnight", () => {
    const weekly: TemporalWeeklySchedule = {
      timeZone: "UTC",
      utcOffsetMinutes: 0,
      basePhase: "peak",
      baseEffect: { ...OFFPEAK_UNCHANGED },
      windows: [
        {
          days: ALL_DAYS,
          startMinute: 840,
          endMinute: 1440,
          phase: "offpeak",
          effect: { factor: 0.5, direction: "offpeak", unit: "api_price" },
        },
      ],
    };
    const schedule = describeTemporalSchedule(
      weeklyModel(weekly),
      Date.parse("2027-01-11T12:00:00Z"),
      { timeZone: "Europe/Istanbul", locale: "en-US" },
    );
    expect(schedule.kind).toBe("weekly");
    if (schedule.kind !== "weekly") return;
    expect(schedule.basePhase).toBe("peak");
    expect(schedule.windows).toEqual([
      {
        days: ALL_DAYS,
        startMinute: 0,
        endMinute: 180,
        phase: "offpeak",
        effect: { factor: 0.5, direction: "offpeak", unit: "api_price" },
      },
      {
        days: ALL_DAYS,
        startMinute: 1020,
        endMinute: 1440,
        phase: "offpeak",
        effect: { factor: 0.5, direction: "offpeak", unit: "api_price" },
      },
    ]);
  });

  it("moves UTC weekdays across local midnight in a US zone", () => {
    const schedule = describeTemporalSchedule(
      weeklyModel(deepSeekWeekly()),
      Date.parse("2027-01-11T12:00:00Z"),
      { timeZone: "America/New_York", locale: "en-US" },
    );
    expect(schedule.kind).toBe("weekly");
    if (schedule.kind !== "weekly") return;
    expect(schedule.windows).toEqual([
      { days: MON_FRI, startMinute: 60, endMinute: 300, phase: "peak", effect: PEAK_2X },
      {
        days: ["mon", "tue", "wed", "thu", "sun"],
        startMinute: 1200,
        endMinute: 1380,
        phase: "peak",
        effect: PEAK_2X,
      },
    ]);
  });

  it("falls back to exact dates when the local zone changes offset soon", () => {
    const schedule = describeTemporalSchedule(
      weeklyModel(deepSeekWeekly()),
      Date.parse("2026-10-30T12:00:00Z"),
      { timeZone: "America/New_York", locale: "en-US" },
    );
    expect(schedule.kind).toBe("dates");
    if (schedule.kind !== "dates") return;
    expect(schedule.localClockChanges).toBe(true);
    expect(schedule.intervals.length).toBeGreaterThan(0);
  });

  it("keeps the weekly view after a DST transition has passed", () => {
    const schedule = describeTemporalSchedule(
      weeklyModel(deepSeekWeekly()),
      Date.parse("2026-11-10T12:00:00Z"),
      { timeZone: "America/New_York", locale: "en-US" },
    );
    expect(schedule.kind).toBe("weekly");
  });

  it("keeps a base-only weekly description through a local clock change", () => {
    const weekly = { ...deepSeekWeekly(), windows: [] };
    const schedule = describeTemporalSchedule(
      weeklyModel(weekly),
      Date.parse("2026-10-30T12:00:00Z"),
      { timeZone: "America/New_York", locale: "en-US" },
    );
    expect(schedule.kind).toBe("weekly");
    if (schedule.kind !== "weekly") return;
    expect(schedule.windows).toEqual([]);
    expect(schedule.basePhase).toBe("offpeak");
  });

  it("keeps the current three-day projection as exact dates", () => {
    const schedule = describeTemporalSchedule(deepseek.models[0] as TemporalModelStatus, NOW);
    expect(schedule.kind).toBe("dates");
  });

  it("treats one unresolved model as an unknown provider aggregate", () => {
    const unknown = model("unresolved", "unknown");
    expect(combineTemporalPhases([model("peak", "peak"), unknown], NOW)).toBe("unknown");
    expect(combineTemporalPhases([model("peak", "peak"), model("offpeak", "offpeak")], NOW)).toBe(
      "mixed",
    );
  });

  it("names the next destination instead of only the countdown", () => {
    const next = temporalModelNextChange(deepseek.models[0] as TemporalModelStatus, NOW);
    expect(next?.phase).toBe("offpeak");
    expect(next?.atMs).toBe(NOW + 2 * HOUR);
  });

  it("keeps a far destination absent when the payload does not state it", () => {
    const currentOnly: TemporalModelStatus = {
      ...model("far", "peak", 2),
      intervals: [model("far", "peak", 2).intervals[0] as TemporalModelInterval],
      nextChangeAtMs: NOW + 4 * DAY,
    };
    expect(temporalModelNextChange({ ...currentOnly, nextState: "offpeak" }, NOW)).toMatchObject({
      atMs: NOW + 4 * DAY,
      phase: "offpeak",
    });
    const absent = temporalModelNextChange(currentOnly, NOW);
    expect(absent?.atMs).toBe(NOW + 4 * DAY);
    expect(absent?.phase).toBeUndefined();
    const explicitUnknown = temporalModelNextChange({ ...currentOnly, nextState: "unknown" }, NOW);
    expect(explicitUnknown?.phase).toBe("unknown");
  });

  it("takes the earlier transition and leaves a disputed destination unnamed", () => {
    const base = model("precedence", "peak", 2);
    const early = temporalModelNextChange(
      { ...base, nextChangeAtMs: NOW + HOUR, nextState: "peak" },
      NOW,
    );
    expect(early).toMatchObject({ atMs: NOW + HOUR, phase: "peak" });

    // The exact window and the server's destination name the same instant but
    // disagree. Neither label is asserted.
    const disputed = temporalModelNextChange({ ...base, nextState: "peak" }, NOW);
    expect(disputed?.atMs).toBe(NOW + 2 * HOUR);
    expect(disputed?.phase).toBeUndefined();

    // An explicitly unresolved destination is not overridden by the locally
    // projected window phase; the UI stays neutral at that instant.
    const unresolved = temporalModelNextChange({ ...base, nextState: "unknown" }, NOW);
    expect(unresolved?.atMs).toBe(NOW + 2 * HOUR);
    expect(unresolved?.phase).toBeUndefined();
  });

  it("distinguishes a scalar effect from buckets that change it", () => {
    expect(temporalEffectVaries(deepseek.models[0] as TemporalModelStatus, NOW)).toBe(true);
    expect(temporalEffectVaries(zai.models[0] as TemporalModelStatus, NOW)).toBe(false);
  });

  it("groups models only when their complete policy is identical", () => {
    const first = model("first", "peak", 2);
    const second = { ...first, modelId: "second" };
    const groups = groupTemporalModels([first, second, zai.models[0] as TemporalModelStatus]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.models.map((entry) => entry.modelId)).toEqual(["first", "second"]);
  });

  it("keeps routes apart when their future policy snapshot differs", () => {
    const first = model("first", "peak", 2);
    const same = { ...first, modelId: "same" };
    const nextTime = { ...first, modelId: "next-time", nextChangeAtMs: NOW + 4 * HOUR };
    const nextState = { ...first, modelId: "next-state", nextState: "peak" as const };
    const futureWindow = {
      ...first,
      modelId: "future-window",
      intervals: [
        first.intervals[0] as TemporalModelInterval,
        {
          ...(first.intervals[1] as TemporalModelInterval),
          startMs: NOW + 3 * HOUR,
          endMs: NOW + 6 * HOUR,
        },
      ],
    };
    const groups = groupTemporalModels([first, same, nextTime, nextState, futureWindow]);
    expect(groups).toHaveLength(4);
    const sameGroup = groups.find((group) =>
      group.models.some((entry) => entry.modelId === "first"),
    );
    expect(sameGroup?.models.map((entry) => entry.modelId)).toEqual(["first", "same"]);
  });

  it("keeps routes apart when only their weekly descriptor differs", () => {
    const first = weeklyModel(deepSeekWeekly(), { modelId: "weekly-a" });
    const same = { ...first, modelId: "weekly-b" };
    const reordered = {
      ...first,
      modelId: "weekly-d",
      weekly: {
        ...deepSeekWeekly(),
        windows: [...deepSeekWeekly().windows]
          .reverse()
          .map((window) => ({ ...window, days: [...window.days].reverse() })),
      },
    };
    const changed = {
      ...first,
      modelId: "weekly-c",
      weekly: {
        ...deepSeekWeekly(),
        windows: [
          {
            days: MON_FRI,
            startMinute: 90,
            endMinute: 240,
            phase: "peak" as const,
            effect: { ...PEAK_2X },
          },
        ],
      },
    };
    const groups = groupTemporalModels([first, same, reordered, changed]);
    expect(groups).toHaveLength(2);
    const sameGroup = groups.find((group) =>
      group.models.some((entry) => entry.modelId === "weekly-a"),
    );
    expect(sameGroup?.models.map((entry) => entry.modelId)).toEqual([
      "weekly-a",
      "weekly-b",
      "weekly-d",
    ]);
  });
});

// These assertions cover one server render only. Click, pin, Escape and
// viewport placement are exercised in tests/gui.interactive-popover.test.ts.
describe("temporal live status server-rendered markup", () => {
  it("groups compact provider chips by conservative live state", async () => {
    const html = await renderView("/components/temporal-status.tsx", "TemporalStatusStrip", {
      providers: temporal().providers,
      overrides: {},
    });
    expect(html).toContain('aria-label="Temporal pricing status"');
    expect(html.match(/class="qg-temporal__group"/g)).toHaveLength(2);
    expect(html).not.toContain('class="qg-temporal__label"');
    expect(html).toContain('data-phase="peak"');
    expect(html).toContain('data-phase="mixed"');
    expect(html).toContain('aria-label="DeepSeek: Peak. Show peak and off-peak details."');
    expect(html).toContain('aria-label="Test Mixed: Mixed. Show peak and off-peak details."');
    expect(html).toContain('data-provider-logo="deepseek"');
    expect(html).toContain('data-provider-logo="zai"');
  });

  it("puts an unknown model in the conservative unknown group", async () => {
    const unresolved = provider(
      "future-calendar",
      "Future Calendar",
      [model("resolved-model", "peak"), model("unresolved-model", "unknown")],
      "peak",
    );
    const html = await renderView("/components/temporal-status.tsx", "TemporalStatusStrip", {
      providers: [unresolved],
      overrides: {},
    });
    expect(html).toContain('data-phase="unknown"');
    expect(html).not.toContain('data-phase="peak"');
    expect(html).toContain(
      'aria-label="Future Calendar: Unknown. Show peak and off-peak details."',
    );
  });

  it("defaults chips off without an account and honors explicit on and off choices", async () => {
    const providers = temporalWithNoAccount().providers;
    const defaults = await renderView("/components/temporal-status.tsx", "TemporalStatusStrip", {
      providers,
      overrides: {},
    });
    expect(defaults).not.toContain('data-provider-logo="google"');
    expect(defaults).toContain('data-provider-logo="deepseek"');

    const explicit = await renderView("/components/temporal-status.tsx", "TemporalStatusStrip", {
      providers,
      overrides: { google: true, deepseek: false },
    });
    expect(explicit).toContain('data-provider-logo="google"');
    expect(explicit).not.toContain('data-provider-logo="deepseek"');
  });

  it("renders one shared popover with the nearest local holiday, grouped policies and destinations", async () => {
    const duplicate = {
      ...deepseek,
      models: [deepseek.models[0] as TemporalModelStatus, model("deepseek-v4-flash", "peak", 2)],
    };
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: duplicate,
    });
    const text = visibleText(html);
    expect(text).not.toContain("models.dev schedule");
    expect(text).not.toContain("times local to you");
    expect(text).not.toContain("Plan quota schedule");
    expect(text).toContain("2 models · deepseek-v4-pro, deepseek-v4-flash");
    expect(text).toContain("Peak");
    expect(text).toContain("Effect varies by window");
    expect(text).toContain("2× API price");
    expect(text).toContain("Off-peak in 2h");
    expect(text).toContain("Next Holiday:");
    expect(text).not.toContain("Next holiday exception");
    expect(text).toMatch(/11\/15|15\/11|15\.11/);
    expect(text).not.toContain("Nov");
    expect(text).not.toContain("CN");
    expect(text).not.toContain("spring-festival");
    expect(text).not.toContain("Holiday exceptions");
    expect(text).not.toContain("USD");
    expect(html.match(/class="qg-temporal-popover__model"/g)).toHaveLength(1);
  });

  it("labels an ongoing holiday as Current Holiday and a future one as Next Holiday", async () => {
    const now = Date.now();
    const ongoing: TemporalProviderStatus = {
      ...provider("current", "Current Provider", [model("current-model", "peak", 2)], "peak"),
      holidays: [
        {
          jurisdiction: "CN",
          id: "current-holiday",
          localStart: "2026-10-31",
          localEnd: "2026-11-02",
          startMs: now - HOUR,
          endMs: now + HOUR,
        },
      ],
    };
    const currentText = visibleText(
      await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
        status: ongoing,
      }),
    );
    expect(currentText).toContain("Current Holiday:");
    expect(currentText).not.toContain("Next Holiday:");
    expect(currentText).not.toContain("Next holiday exception");

    const futureText = visibleText(
      await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
        status: deepseek,
      }),
    );
    expect(futureText).toContain("Next Holiday:");
    expect(futureText).not.toContain("Current Holiday:");
  });

  it("keeps forbidden schedule-source and exception headings out of the component", () => {
    const component = readFileSync(
      path.join(repoRoot, "src/ui/components/temporal-status.tsx"),
      "utf8",
    );
    for (const forbidden of [
      "models.dev schedule",
      "times local to you",
      "Plan quota schedule",
      "Next holiday exception",
    ]) {
      expect(component).not.toContain(forbidden);
    }
  });

  it("shows exact dated windows instead of claiming a weekly recurrence", async () => {
    const weekly = provider(
      "weekly",
      "Weekly Provider",
      [weekModel(new Date(NOW).toISOString())],
      "offpeak",
    );
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: weekly,
    });
    const text = visibleText(html);
    expect(text).not.toContain("Weekly, local time");
    expect(text).not.toContain("at other times");
    expect(html).not.toContain("qg-temporal-popover__schedule-line");
    expect(html).toContain('class="qg-temporal-popover__interval"');
    expect(html).toContain('class="qg-temporal-popover__time"');
  });

  it("renders one compact peak line and no redundant local or holiday copy", async () => {
    const weekly = provider(
      "deepseek-weekly",
      "DeepSeek",
      [weeklyModel(deepSeekWeekly())],
      "offpeak",
    );
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: weekly,
      nowMs: Date.parse("2026-11-03T12:00:00Z"),
      formatOptions: { timeZone: "Europe/Istanbul", locale: "en-US" },
    });
    const text = visibleText(html);
    expect(html).toContain("qg-temporal-popover__schedule--weekly");
    expect(text).toContain("Peak: Mon–Fri · 04:00–07:00, 09:00–13:00");
    expect((html.match(/qg-temporal-popover__schedule-line/g) ?? []).length).toBe(1);
    expect(text).not.toContain("Weekly, local time");
    expect(text).not.toContain("at other times");
    expect(text).not.toContain("Holiday dates use exact windows.");
    expect(text).not.toContain("2× API price");
    expect(text).toContain("Next Holiday:");
    expect(text).not.toContain("CN");
    expect(text).not.toContain("spring-festival");
    expect(text).not.toContain("models.dev schedule");
    expect(text).not.toContain("times local to you");
  });

  it("wraps only when distinct local day groups require their own line", async () => {
    const weekly = provider(
      "deepseek-weekly",
      "DeepSeek",
      [weeklyModel(deepSeekWeekly())],
      "offpeak",
    );
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: weekly,
      nowMs: Date.parse("2027-01-11T12:00:00Z"),
      formatOptions: { timeZone: "America/New_York", locale: "en-US" },
    });
    const text = visibleText(html);
    expect(text).toContain("Peak: Mon–Fri · 1:00 AM–5:00 AM");
    expect(text).toContain("Peak: Sun–Thu · 8:00 PM–11:00 PM");
    expect((html.match(/qg-temporal-popover__schedule-line/g) ?? []).length).toBe(2);
  });

  it("falls back to dated windows when the local clock changes soon", async () => {
    const weekly = provider(
      "deepseek-weekly",
      "DeepSeek",
      [weeklyModel(deepSeekWeekly())],
      "offpeak",
    );
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: weekly,
      nowMs: Date.parse("2026-10-30T12:00:00Z"),
      formatOptions: { timeZone: "America/New_York", locale: "en-US" },
    });
    const text = visibleText(html);
    expect(text).toContain("Local clock changes; showing exact dates.");
    expect(html).not.toContain("qg-temporal-popover__schedule-line");
    expect(text).not.toContain("Holiday dates use exact windows.");
  });

  it("renders an all-week base when the weekly descriptor has no deviations", async () => {
    const weekly = provider(
      "deepseek-weekly",
      "DeepSeek",
      [
        weeklyModel({
          timeZone: "UTC",
          utcOffsetMinutes: 0,
          basePhase: "offpeak",
          baseEffect: { ...OFFPEAK_UNCHANGED },
          windows: [],
        }),
      ],
      "offpeak",
    );
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: weekly,
      nowMs: Date.parse("2026-11-03T12:00:00Z"),
      formatOptions: { timeZone: "Europe/Istanbul", locale: "en-US" },
    });
    const text = visibleText(html);
    expect(text).toContain("Off-peak all week");
    expect((html.match(/qg-temporal-popover__schedule-line/g) ?? []).length).toBe(1);
    expect(text).not.toContain("at other times");
    expect(text).not.toContain("Weekly, local time");
  });

  it("labels Z.ai effects as quota points and keeps source copy out of the popover", async () => {
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: zai,
    });
    const text = visibleText(html);
    expect(text).toContain("2× quota points");
    expect(text).toContain("Off-peak in 2h");
    expect(text).not.toContain("Effect varies by window");
    expect(text).not.toContain("USD");
    expect(text).not.toContain("models.dev schedule");
    expect(text).not.toContain("times local to you");
    expect(text).not.toContain("Plan quota schedule");
    expect(text).not.toContain("Z.ai current credits-plan usage");
  });

  it("labels a far transition neutrally unless the payload names a different phase", async () => {
    const effect = { factor: 2, direction: "peak" as const, unit: "api_price" as const };
    const interval: TemporalModelInterval = {
      startMs: NOW - HOUR,
      endMs: NOW + 2 * HOUR,
      phase: "peak",
      effect,
    };
    const farModel = (nextState?: "peak" | "offpeak" | "unknown"): TemporalModelStatus => ({
      modelId: "far-model",
      state: "peak",
      effect,
      nextChangeAtMs: NOW + 4 * DAY,
      ...(nextState === undefined ? {} : { nextState }),
      intervals: [interval],
    });
    const render = async (nextState?: "peak" | "offpeak" | "unknown"): Promise<string> =>
      visibleText(
        await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
          status: provider("far", "Far Provider", [farModel(nextState)], "peak"),
        }),
      );

    const absent = await render();
    expect(absent).toContain("Next change in 4d");
    expect(absent).not.toContain("Peak in 4d");
    expect(absent).not.toContain("Off-peak in 4d");

    const offpeak = await render("offpeak");
    expect(offpeak).toContain("Off-peak in 4d");
    expect(offpeak).not.toContain("Next change in 4d");

    // A same-phase transition changes the effect, not the window phase.
    const samePhase = await render("peak");
    expect(samePhase).toContain("Next change in 4d");
    expect(samePhase).not.toContain("Peak in 4d");

    const unknown = await render("unknown");
    expect(unknown).toContain("Next change in 4d");
    expect(unknown).not.toContain("Off-peak in 4d");
  });

  it("explains a live unresolved window instead of only saying Unknown", async () => {
    const unresolved = provider(
      "future-calendar",
      "Future Calendar",
      [
        {
          modelId: "calendar-model",
          state: "offpeak",
          reason: "snapshot-time reason",
          intervals: [
            {
              startMs: NOW - HOUR,
              endMs: NOW + HOUR,
              phase: "unknown",
              reason: "CN public holiday calendar for 2027 is unavailable",
            },
          ],
        },
      ],
      "unknown",
    );
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: unresolved,
    });
    const text = visibleText(html);
    expect(text).toContain("Unknown");
    expect(text).toContain("CN public holiday calendar for 2027 is unavailable");
    expect(text).not.toContain("snapshot-time reason");
  });

  it("keeps the header strip quiet and the settings empty state explicit", async () => {
    const empty: TemporalStatusSnapshot = { ...temporal(), providers: [] };
    const strip = await renderView("/components/temporal-status.tsx", "TemporalStatusStrip", {
      providers: empty.providers,
      overrides: {},
    });
    expect(strip).not.toContain('aria-label="Temporal pricing status"');

    const settingsHtml = await renderView("/views/settings.tsx", "SettingsView", {
      snapshot: temporalSettings(),
      client: {},
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: { cards: [] },
      temporal: empty,
      onReload: async () => {},
    });
    const text = visibleText(settingsHtml);
    expect(text).toContain("No temporal pricing providers are available.");
    expect(text).not.toContain("Defaults follow discovered accounts.");
  });

  it("lists every temporal provider with account-driven defaults and explicit overrides", async () => {
    const base = {
      snapshot: temporalSettings(),
      client: {},
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: { cards: [] },
      temporal: temporalWithNoAccount(),
      onReload: async () => {},
    };
    const defaultsHtml = await renderView("/views/settings.tsx", "SettingsView", base);
    expect(defaultsHtml.match(/class="qg-field qg-temporal-settings__row"/g)).toHaveLength(4);
    const defaultRows = defaultsHtml.split('<div class="qg-field qg-temporal-settings__row">');
    const googleRow =
      defaultRows.find((row) => row.includes("Show peak and off-peak pricing for Google")) ?? "";
    const deepseekRow =
      defaultRows.find((row) => row.includes("Show peak and off-peak pricing for DeepSeek")) ?? "";
    expect(googleRow).toContain('aria-checked="false"');
    expect(deepseekRow).toContain('aria-checked="true"');
    const defaultText = visibleText(defaultsHtml);
    expect(defaultText).toContain("No account discovered.");
    expect(defaultText).toContain("Defaults follow discovered accounts.");

    const overridesHtml = await renderView("/views/settings.tsx", "SettingsView", {
      ...base,
      snapshot: temporalSettings({ google: true, deepseek: false, zai: true }),
    });
    const rows = overridesHtml.split('<div class="qg-field qg-temporal-settings__row">');
    const googleOverride = rows.find((row) => row.includes("pricing for Google")) ?? "";
    const deepseekOverride = rows.find((row) => row.includes("pricing for DeepSeek")) ?? "";
    const zaiOverride = rows.find((row) => row.includes("pricing for Z.ai")) ?? "";
    expect(googleOverride).toContain('aria-checked="true"');
    expect(deepseekOverride).toContain('aria-checked="false"');
    expect(zaiOverride).toContain('aria-checked="true"');
    expect(visibleText(overridesHtml)).toContain(
      "3 manual choices; the rest follow discovered accounts.",
    );
    expect(overridesHtml).toContain('id="qg-settings-temporal"');
    expect(overridesHtml).toContain('data-provider-logo="google"');
    expect(overridesHtml).toContain('aria-label="Peak and off-peak pricing details for DeepSeek"');
  });

  it("moves the status buttons into the selected Quota header and removes the duplicate heading", () => {
    const topbarLeft = appSource.indexOf('class="qg-topbar__left"');
    const strip = appSource.indexOf("<TemporalStatusStrip");
    const frame = appSource.indexOf('<div class="qg-frame">');
    expect(strip).toBeGreaterThan(topbarLeft);
    expect(strip).toBeGreaterThan(frame);
    expect(strip).toBeLessThan(appSource.indexOf("</header>", topbarLeft));
    expect(quotaViewSource).not.toContain("<TemporalStatusStrip");
    expect(quotaViewSource).not.toMatch(/<h2[^>]*>\s*Quota\s*<\/h2>/);
    expect(quotaViewSource).toContain('class="qg-quota__meta"');
    expect(styles).toMatch(/\.qg-quota__meta\s*\{[^}]*justify-content:\s*center/s);
  });

  it("does not add an independent clock or poll to the temporal UI", () => {
    const component = readFileSync(
      path.join(repoRoot, "src/ui/components/temporal-status.tsx"),
      "utf8",
    );
    const format = readFileSync(path.join(repoRoot, "src/ui/temporal-format.ts"), "utf8");
    const popover = readFileSync(
      path.join(repoRoot, "src/ui/components/interactive-popover.tsx"),
      "utf8",
    );
    for (const source of [component, format, popover]) {
      expect(source).not.toMatch(/setInterval/);
    }
    for (const source of [component, format]) {
      expect(source).not.toMatch(/\bonMount\b|\bonCleanup\b|\bsetTimeout\b/);
    }
  });

  it("keeps the issue #9 text-then-control row contract and local styles scoped", () => {
    expect(styles).toContain(".qg-temporal-settings__row");
    expect(styles).toContain(".qg-temporal-popover");
    expect(styles).toContain("--qg-temporal-peak");
    expect(styles).toMatch(/\.qg-temporal__logo\s*\{[^}]*color:\s*var\(--qg-text-muted\)/s);
    expect(styles).toMatch(/\.qg-temporal__arrow\[data-phase="peak"\]/);
    expect(styles).toMatch(/\.qg-temporal__arrow\[data-phase="offpeak"\]/);
    expect(styles).not.toMatch(/\.qg-temporal__chip\s*\{[^}]*border-radius:\s*999px/s);
    expect(styles).toMatch(
      /\.qg-field\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(220px, 320px\)/s,
    );
    expect(styles).not.toMatch(/\.qg-field\s*\{[^}]*grid-template-columns:\s*1fr\s*;/s);
  });
});
