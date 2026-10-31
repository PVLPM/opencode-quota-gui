import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderCard, QuotaSnapshot, SettingsSnapshot } from "../src/contracts/dashboard.js";
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
  temporalEffectLabel,
  temporalEffectVaries,
  temporalModelNextChange,
} from "../src/ui/temporal-format.js";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import { percentRow, providerCard, settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
const appSource = readFileSync(path.join(repoRoot, "src/ui/app.tsx"), "utf8");
const quotaViewSource = readFileSync(path.join(repoRoot, "src/ui/views/home.tsx"), "utf8");
const chromium = [
  process.env.QG_LAYOUT_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));
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
          scalar: true,
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
    scalar: true,
  };
  const peak = {
    factor: 2,
    direction: "peak" as const,
    unit: "api_price" as const,
    scalar: true,
  };
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
  scalar: true,
};
const PEAK_2X = {
  factor: 2,
  direction: "peak" as const,
  unit: "api_price" as const,
  scalar: true,
};

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
  it("labels only server-proven scalars as multipliers", () => {
    expect(
      temporalEffectLabel({ factor: 2, direction: "peak", unit: "api_price", scalar: true }),
    ).toBe("API price: 2×");
    expect(
      temporalEffectLabel({ factor: 1, direction: "unchanged", unit: "api_price", scalar: true }),
    ).toBe("API price: 1×");
    expect(
      temporalEffectLabel({ factor: 0.5, direction: "offpeak", unit: "api_price", scalar: false }),
    ).toBe("API price varies by token type");
    // Quota-point effects are scalar plan multipliers and omit the cross-rate
    // comparison by contract.
    expect(temporalEffectLabel({ factor: 0.5, direction: "offpeak", unit: "quota_points" })).toBe(
      "Quota points: 0.5×",
    );
    // Malformed quota-point data must never be described as an API-price
    // change; the unit takes precedence over the cross-rate field.
    expect(
      temporalEffectLabel({
        factor: 0.5,
        direction: "offpeak",
        unit: "quota_points",
        scalar: false,
      }),
    ).toBe("Quota points: 0.5×");
    expect(
      temporalEffectLabel({
        factor: 0.5,
        direction: "offpeak",
        unit: "quota_points",
        scalar: true,
      }),
    ).toBe("Quota points: 0.5×");
    // Monetary absence is not proof of non-scalarity; report direction only.
    expect(temporalEffectLabel({ factor: 2, direction: "peak", unit: "api_price" })).toBe(
      "API price: higher",
    );
    expect(temporalEffectLabel({ factor: 0.5, direction: "offpeak", unit: "api_price" })).toBe(
      "API price: lower",
    );
    expect(temporalEffectLabel({ factor: 1, direction: "unchanged", unit: "api_price" })).toBe(
      "API price: unchanged",
    );
  });

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

  it("distinguishes the scalar indicator in top-level and weekly policy identity", () => {
    const scalarModel = model("scalar-effect", "peak", 2);
    const partialModel: TemporalModelStatus = {
      ...scalarModel,
      modelId: "partial-effect",
      effect: {
        factor: 2,
        direction: "peak",
        unit: "api_price",
        scalar: false,
      },
    };
    expect(groupTemporalModels([scalarModel, partialModel])).toHaveLength(2);

    const weeklyScalar = weeklyModel(deepSeekWeekly(), { modelId: "weekly-scalar" });
    const weeklyPartial = weeklyModel(
      {
        ...deepSeekWeekly(),
        baseEffect: { ...OFFPEAK_UNCHANGED, scalar: false },
      },
      { modelId: "weekly-partial" },
    );
    expect(groupTemporalModels([weeklyScalar, weeklyPartial])).toHaveLength(2);
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
    const mixedStart = html.indexOf('class="qg-temporal__group" data-phase="mixed"');
    const mixedHtml = html.slice(mixedStart, html.indexOf("</fieldset>", mixedStart));
    expect(mixedHtml.indexOf('data-phase="offpeak"')).toBeGreaterThan(-1);
    expect(mixedHtml.indexOf('data-phase="offpeak"')).toBeLessThan(
      mixedHtml.indexOf('data-phase="peak"'),
    );
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
    expect(text).not.toContain("Effect varies by window");
    expect(text).toContain("API price: 2×");
    expect(text).toContain("API price: 0.5×");
    expect(text).toContain("API price: 2× • Off-peak in 2h");
    expect(html).toContain('class="qg-temporal-popover__summary"');
    expect(html).toContain('class="qg-temporal-popover__separator"');
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

  it("shows the current effective multiplier for scalar and genuinely varying windows", async () => {
    const varying = {
      ...deepseek,
      models: [
        {
          ...(deepseek.models[0] as TemporalModelStatus),
          modelId: "varying-model",
        },
      ],
    };
    const varyingHtml = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: varying,
      nowMs: NOW,
    });
    const varyingText = visibleText(varyingHtml);
    expect(varyingText).toContain("API price: 2×");
    expect(varyingText).toContain("API price: 0.5×");
    expect(varyingText).toContain("API price: 2× • Off-peak in 2h");
    expect(varyingText).not.toContain("Effect varies by window");

    const scalar = provider(
      "scalar",
      "Scalar Provider",
      [
        {
          modelId: "scalar-model",
          state: "peak",
          effect: { factor: 1.5, direction: "peak", unit: "api_price", scalar: true },
          intervals: [
            {
              startMs: NOW - HOUR,
              endMs: NOW + HOUR,
              phase: "peak",
              effect: { factor: 1.5, direction: "peak", unit: "api_price", scalar: true },
            },
          ],
        },
      ],
      "peak",
    );
    const scalarText = visibleText(
      await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
        status: scalar,
        nowMs: NOW,
      }),
    );
    expect(scalarText).toContain("API price: 1.5×");
    expect(scalarText).not.toContain("Effect varies by window");

    const nonScalar = provider(
      "non-scalar",
      "Non-scalar Provider",
      [
        {
          modelId: "non-scalar-model",
          state: "offpeak",
          effect: { factor: 0.5, direction: "offpeak", unit: "api_price", scalar: false },
          intervals: [
            {
              startMs: NOW - HOUR,
              endMs: NOW + HOUR,
              phase: "offpeak",
              effect: {
                factor: 0.5,
                direction: "offpeak",
                unit: "api_price",
                scalar: false,
              },
            },
          ],
        },
      ],
      "offpeak",
    );
    const nonScalarText = visibleText(
      await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
        status: nonScalar,
        nowMs: NOW,
      }),
    );
    expect(nonScalarText).toContain("API price varies by token type");
    expect(nonScalarText).not.toContain("API price: 0.5×");
    expect(nonScalarText).not.toContain("Effect varies by window");

    const legacyEffect = { factor: 2, direction: "peak" as const, unit: "api_price" as const };
    const legacy = provider(
      "legacy",
      "Legacy Provider",
      [
        {
          modelId: "legacy-model",
          state: "peak",
          effect: legacyEffect,
          intervals: [
            {
              startMs: NOW - HOUR,
              endMs: NOW + HOUR,
              phase: "peak",
              effect: legacyEffect,
            },
          ],
        },
      ],
      "peak",
    );
    const legacyText = visibleText(
      await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
        status: legacy,
        nowMs: NOW,
      }),
    );
    expect(legacyText).toContain("API price: higher");
    expect(legacyText).not.toContain("API price: 2×");
    expect(legacyText).not.toContain("API price varies by token type");
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

  it("does not repeat the active effect in the dated schedule", async () => {
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: deepseek,
      nowMs: NOW,
    });
    const intervals = html.split('class="qg-temporal-popover__interval"').slice(1);
    expect(intervals).toHaveLength(2);
    // The summary already states the active 2x effect, so the active row must
    // not repeat it. The future 0.5x row still needs its own label.
    expect(intervals[0]).not.toContain("qg-temporal-popover__effect");
    expect(intervals[1]).toContain("qg-temporal-popover__effect");
    expect(intervals[1]).toContain("API price: 0.5×");
    expect((html.match(/qg-temporal-popover__effect/g) ?? []).length).toBe(2);
    const text = visibleText(html);
    expect(text).toContain("API price: 2×");
    expect(text).toContain("API price: 0.5×");
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
    expect(text).toContain("API price: 1×");
    expect(text).not.toContain("No change to API price");
    expect(text).not.toContain("API price: 2×");
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
    expect(text).toContain("Quota points: 2×");
    expect(text).toContain("Quota points: 2× • Off-peak in 2h");
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
    const topbarActions = appSource.indexOf('class="qg-topbar__actions"');
    const strip = appSource.indexOf("<TemporalStatusStrip");
    const frame = appSource.indexOf('<div class="qg-frame">');
    expect(strip).toBeGreaterThan(topbarLeft);
    expect(strip).toBeGreaterThan(topbarActions);
    expect(strip).toBeGreaterThan(frame);
    expect(strip).toBeLessThan(appSource.indexOf("</header>", topbarLeft));
    expect(styles).toMatch(
      /\.qg-frame > \.qg-topbar > \.qg-topbar__actions\s*\{[^}]*margin-left:\s*auto/s,
    );
    expect(quotaViewSource).not.toContain("<TemporalStatusStrip");
    expect(quotaViewSource).not.toMatch(/<h2[^>]*>\s*Quota\s*<\/h2>/);
    expect(quotaViewSource).toContain('class="qg-section qg-quota"');
    expect(quotaViewSource).toContain('class="qg-quota__meta"');
    expect(quotaViewSource.indexOf('<footer class="qg-quota__meta">')).toBeGreaterThan(
      quotaViewSource.indexOf('<div class="qg-card-grid">'),
    );
    expect(styles).toMatch(/\.qg-quota\s*\{[^}]*flex-grow:\s*1/s);
    expect(styles).toMatch(/\.qg-quota__meta\s*\{[^}]*margin-top:\s*auto/s);
    expect(styles).toMatch(/\.qg-quota__meta\s*\{[^}]*justify-content:\s*center/s);
    expect(styles).not.toMatch(/\.qg-quota__meta\s*\{[^}]*position:\s*absolute/s);
  });

  it("does not fall back to vague effect copy", () => {
    const component = readFileSync(
      path.join(repoRoot, "src/ui/components/temporal-status.tsx"),
      "utf8",
    );
    const format = readFileSync(path.join(repoRoot, "src/ui/temporal-format.ts"), "utf8");
    expect(component).not.toContain("Effect varies by window");
    expect(format).not.toContain("No change to");
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
    expect(styles).toMatch(/--qg-temporal-peak:\s*var\(--qg-danger\)/);
    expect(styles).toMatch(/--qg-temporal-offpeak:\s*var\(--qg-success\)/);
    expect(styles).toMatch(/\.qg-temporal__chip\s*\{[^}]*border:\s*1px solid var\(--qg-border\)/s);
    expect(styles).toMatch(/\.qg-temporal__chip\s*\{[^}]*border-radius:\s*6px/s);
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

function layoutCard(index: number, rowCount: number): ProviderCard {
  return providerCard({
    cardId: `layout-card-${index}#hash` as ProviderCard["cardId"],
    providerLabel: `Layout Provider ${index}`,
    accountLabel: `Account ${index}`,
    rows: Array.from({ length: rowCount }, (_, rowIndex) =>
      percentRow({
        rowId: `layout-card-${index}#row-${rowIndex}` as ProviderCard["rows"][number]["rowId"],
        label: `Window ${rowIndex + 1}`,
        percentRemaining: 62,
        percentUsed: 38,
      }),
    ),
  });
}

function quotaSnapshotForLayout(cards: ProviderCard[]): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: false,
    timeZone: "UTC",
    providers: { cards, enabledProviders: "auto", polledAtMs: NOW - 60_000 },
    temporal: temporal(),
  };
}

interface QuotaLayoutProbe {
  error?: string;
  viewport: { width: number; height: number };
  topbar: { right: number; paddingRight: number };
  actions: { right: number };
  chip: {
    height: number;
    borderTopWidth: string;
    borderTopStyle: string;
    borderTopColor: string;
    borderRadius: string;
    backgroundColor: string;
  };
  logoColor: string;
  peakColor: string;
  offpeakColor: string;
  mixedOrder: string[];
  main: {
    scrollHeight: number;
    clientHeight: number;
    contentBottom: number;
    paddingBottom: number;
  };
  footer: { top: number; bottom: number };
  grid: { bottom: number };
  summary: { text: string; sameLine: boolean } | null;
}

function runLayoutProbe(pageHtml: string, width: number, height: number): QuotaLayoutProbe {
  if (chromium === undefined) throw new Error("no local Chromium is available");
  const directory = mkdtempSync(path.join(os.tmpdir(), "qg-quota-layout-"));
  try {
    const page = path.join(directory, "page.html");
    writeFileSync(page, pageHtml, "utf8");
    const dom = execFileSync(
      chromium,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        `--user-data-dir=${path.join(directory, "profile")}`,
        `--window-size=${width},${height}`,
        "--virtual-time-budget=8000",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    const captured = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom);
    if (captured?.[1] === undefined || captured[1] === "pending") {
      throw new Error(`quota layout probe produced no result; output tail: ${dom.slice(-2000)}`);
    }
    return JSON.parse(captured[1]) as QuotaLayoutProbe;
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function layoutPage(quotaHtml: string, stripHtml: string, popoverHtml = ""): string {
  const appCss = styles.replaceAll("</style", "<\\/style");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>:root{--font-size-small:13px;--font-size-large:16px;--font-weight-medium:500;--surface-raised-base-hover:rgba(255,255,255,.078);--text-interactive-base:#9dbefe;--border-interactive-active:#9dbefe;--icon-critical-base:#fc533a;--icon-success-base:#12c905;--icon-warning-base:#fbb73c;--shadow-md:0 1px 2px rgba(0,0,0,.4);}html,body{margin:0;height:100%;font:13px system-ui,sans-serif}#result{position:fixed;left:-9999px;top:0}</style>
<style>${appCss}</style>
</head>
<body>
<div class="qg-app"><div class="qg-frame">
<header class="qg-topbar"><div class="qg-topbar__left"><span class="qg-frame-tab">Quota</span></div><div class="qg-topbar__actions">${stripHtml}</div></header>
<main class="qg-main">${quotaHtml}</main>
</div></div>
<div id="popover-probe" style="position:fixed;left:-10000px;top:0;width:380px">${popoverHtml}</div>
<pre id="result">pending</pre>
<script>
const finish = () => {
  try {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error("missing " + selector);
      const box = element.getBoundingClientRect();
      return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
    };
    const main = document.querySelector(".qg-main");
    const topbar = document.querySelector(".qg-topbar");
    const actions = document.querySelector(".qg-topbar__actions");
    const chip = document.querySelector(".qg-temporal__chip");
    const logo = document.querySelector(".qg-temporal__logo");
    const mixed = document.querySelector('.qg-temporal__group[data-phase="mixed"]');
    const peak = document.querySelector('.qg-temporal__arrow[data-phase="peak"]');
    const offpeak = document.querySelector('.qg-temporal__arrow[data-phase="offpeak"]');
    if (!main || !topbar || !actions || !chip || !logo || !mixed || !peak || !offpeak) {
      throw new Error("layout probe elements are missing");
    }
    const chipStyle = getComputedStyle(chip);
    const topbarStyle = getComputedStyle(topbar);
    const mainStyle = getComputedStyle(main);
    const mainBox = main.getBoundingClientRect();
    const footer = rect(".qg-quota__meta");
    const grid = rect(".qg-card-grid");
    const mixedOrder = Array.from(mixed.querySelectorAll(".qg-temporal__arrow")).map((arrow) => arrow.getAttribute("data-phase"));
    const summary = document.querySelector(".qg-temporal-popover__summary");
    const summaryEffect = summary ? summary.querySelector(".qg-temporal-popover__effect") : null;
    const summaryNext = summary ? summary.querySelector(".qg-temporal-popover__next") : null;
    const summaryProbe = summary
      ? {
          text: (summary.textContent || "").replace(/s+/g, " ").trim(),
          sameLine:
            summaryEffect && summaryNext
              ? Math.abs(summaryEffect.getBoundingClientRect().top - summaryNext.getBoundingClientRect().top) <= 1
              : false,
        }
      : null;
    const result = {
      viewport: { width: innerWidth, height: innerHeight },
      topbar: { right: rect(".qg-topbar").right, paddingRight: parseFloat(topbarStyle.paddingRight) },
      actions: { right: rect(".qg-topbar__actions").right },
      chip: {
        height: rect(".qg-temporal__chip").height,
        borderTopWidth: chipStyle.borderTopWidth,
        borderTopStyle: chipStyle.borderTopStyle,
        borderTopColor: chipStyle.borderTopColor,
        borderRadius: chipStyle.borderRadius,
        backgroundColor: chipStyle.backgroundColor,
      },
      logoColor: getComputedStyle(logo).color,
      peakColor: getComputedStyle(peak).color,
      offpeakColor: getComputedStyle(offpeak).color,
      mixedOrder,
      main: {
        scrollHeight: main.scrollHeight,
        clientHeight: main.clientHeight,
        contentBottom: mainBox.bottom - parseFloat(mainStyle.paddingBottom),
        paddingBottom: parseFloat(mainStyle.paddingBottom),
      },
      footer: { top: footer.top, bottom: footer.bottom },
      grid: { bottom: grid.bottom },
      summary: summaryProbe,
    };
    document.getElementById("result").textContent = JSON.stringify(result);
  } catch (error) {
    document.getElementById("result").textContent = JSON.stringify({ error: String(error) });
  }
};
if (document.fonts && document.fonts.ready) document.fonts.ready.then(finish);
else finish();
</script>
</body>
</html>`;
}

describe.skipIf(chromium === undefined)("temporal controls and Polled footer in Chromium", () => {
  it("right-aligns the Quota tab bar controls and keeps the footer at the visual bottom", async () => {
    const strip = await renderView("/components/temporal-status.tsx", "TemporalStatusStrip", {
      providers: temporal().providers,
      overrides: {},
    });
    const popover = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: deepseek,
      nowMs: NOW,
    });
    const preferences = {
      percentMode: "remaining" as const,
      percentLabelStyle: "full" as const,
      showRunway: false,
      detailed: true,
    };
    const shortQuota = await renderView("/views/home.tsx", "QuotaView", {
      snapshot: quotaSnapshotForLayout([layoutCard(1, 1)]),
      preferences,
      hiddenCards: [],
      hiddenRows: [],
      stale: false,
    });
    const tallQuota = await renderView("/views/home.tsx", "QuotaView", {
      snapshot: quotaSnapshotForLayout(
        Array.from({ length: 8 }, (_, index) => layoutCard(index + 1, 12)),
      ),
      preferences,
      hiddenCards: [],
      hiddenRows: [],
      stale: false,
    });

    const wide = runLayoutProbe(layoutPage(shortQuota, strip, popover), 1440, 900);
    expect(wide.error).toBeUndefined();
    expect(wide.summary?.text).toBe("API price: 2× • Off-peak in 2h");
    expect(wide.summary?.sameLine).toBe(true);
    const wideContentRight = wide.topbar.right - wide.topbar.paddingRight;
    expect(Math.abs(wide.actions.right - wideContentRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(wide.footer.bottom - wide.main.contentBottom)).toBeLessThanOrEqual(1);
    expect(wide.footer.top).toBeGreaterThanOrEqual(wide.grid.bottom);
    expect(wide.main.scrollHeight).toBeLessThanOrEqual(wide.main.clientHeight + 1);
    expect(wide.chip.height).toBeGreaterThanOrEqual(27.5);
    expect(wide.chip.height).toBeLessThanOrEqual(28.5);
    expect(wide.chip.borderTopWidth).toBe("1px");
    expect(wide.chip.borderTopStyle).toBe("solid");
    expect(wide.chip.borderTopColor).toBe("rgb(48, 48, 48)");
    expect(wide.chip.borderRadius).toBe("6px");
    expect(wide.chip.backgroundColor).toBe("rgb(35, 35, 35)");
    expect(wide.logoColor).toBe("rgb(150, 150, 150)");
    expect(wide.peakColor).toBe("rgb(252, 83, 58)");
    expect(wide.offpeakColor).toBe("rgb(18, 201, 5)");
    expect(wide.mixedOrder).toEqual(["offpeak", "peak"]);

    const narrow = runLayoutProbe(layoutPage(tallQuota, strip), 520, 760);
    expect(narrow.error).toBeUndefined();
    const narrowContentRight = narrow.topbar.right - narrow.topbar.paddingRight;
    expect(Math.abs(narrow.actions.right - narrowContentRight)).toBeLessThanOrEqual(1);
    expect(narrow.main.scrollHeight).toBeGreaterThan(narrow.main.clientHeight);
    expect(narrow.footer.top).toBeGreaterThanOrEqual(narrow.grid.bottom);
    expect(narrow.footer.bottom).toBeGreaterThan(narrow.main.contentBottom);
  });
});
