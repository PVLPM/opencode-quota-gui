import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type {
  TemporalModelPhase,
  TemporalModelStatus,
  TemporalPhase,
  TemporalProviderStatus,
  TemporalWeekday,
} from "../../contracts/temporal";
import { Icon } from "../opencode-ui";
import { resolveProviderPresentation } from "../provider-catalog";
import {
  describeTemporalSchedule,
  formatClockRange,
  formatLocalInterval,
  formatTemporalCountdown,
  formatTemporalHoliday,
  groupTemporalModels,
  isCurrentTemporalHoliday,
  nearestTemporalHoliday,
  type TemporalDatedSchedule,
  type TemporalFormatOptions,
  type TemporalLocalWeeklyWindow,
  type TemporalModelGroup,
  type TemporalScheduleDescription,
  type TemporalWeeklyScheduleDescription,
  temporalEffectLabel,
  temporalEffectVaries,
  temporalModelNextChange,
  temporalModelPhaseLabel,
  temporalModelStateAt,
  temporalPhaseLabel,
  temporalProviderPhaseAt,
  upcomingTemporalIntervals,
} from "../temporal-format";
import { OffpeakArrowIcon, PeakArrowIcon } from "./icons";
import { InteractivePopover } from "./interactive-popover";
import { ProviderLogo } from "./provider-logo";

/**
 * Shared temporal status affordances (Quota and Settings).
 *
 * The DTO is already evaluated; this module only formats it. Time advances with
 * the existing dashboard refresh cycle: there is no independent clock or poll.
 * All times are rendered in the browser's zone; holiday dates keep the
 * jurisdiction's own civil dates from the snapshot.
 */

/** Browser presentation label, with the server label as a fallback. */
export function temporalProviderLabel(status: TemporalProviderStatus): string {
  const presentation = resolveProviderPresentation(status.providerId);
  return presentation.label === status.providerId ? status.providerLabel : presentation.label;
}

function phaseIcon(phase: TemporalPhase): JSX.Element {
  if (phase === "peak") {
    return (
      <span class="qg-temporal__arrow" data-phase="peak">
        <PeakArrowIcon />
      </span>
    );
  }
  if (phase === "offpeak") {
    return (
      <span class="qg-temporal__arrow" data-phase="offpeak">
        <OffpeakArrowIcon />
      </span>
    );
  }
  if (phase === "mixed") {
    return (
      <>
        <span class="qg-temporal__arrow" data-phase="offpeak">
          <OffpeakArrowIcon />
        </span>
        <span class="qg-temporal__arrow" data-phase="peak">
          <PeakArrowIcon />
        </span>
      </>
    );
  }
  return (
    <span class="qg-temporal__unknown" aria-hidden="true">
      —
    </span>
  );
}

function nextChangeLabel(
  nextPhase: TemporalModelStatus["state"] | undefined,
  currentPhase: TemporalModelStatus["state"],
): string {
  if (nextPhase === "peak" || nextPhase === "offpeak") {
    // A same-phase transition changes the effect or reason, not the window
    // phase; naming the phase again would imply a window change that is false.
    return nextPhase === currentPhase ? "Next change" : temporalModelPhaseLabel(nextPhase);
  }
  return "Next change";
}

const WEEKDAY_ORDER: readonly TemporalWeekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Compact local weekday label; a run that wraps Sunday stays one range. */
function formatWeekdayList(days: readonly TemporalWeekday[]): string {
  const indices = [...new Set(days)]
    .map((day) => WEEKDAY_ORDER.indexOf(day))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  if (indices.length === 0) return "—";
  if (indices.length === 7) return "Daily";
  if (indices.length === 1) return WEEKDAY_LABELS[indices[0] as number] ?? "—";

  const present = new Set(indices);
  const starts = indices.filter((index) => !present.has((index + 6) % 7));
  if (starts.length === 1) {
    const start = starts[0] as number;
    let end = start;
    for (let step = 1; step < 7; step += 1) {
      const next = (start + step) % 7;
      if (!present.has(next)) break;
      end = next;
    }
    return `${WEEKDAY_LABELS[start]}–${WEEKDAY_LABELS[end]}`;
  }

  const ranges: string[] = [];
  let rangeStart = indices[0] as number;
  let rangeEnd = rangeStart;
  for (const index of indices.slice(1)) {
    if (index === rangeEnd + 1) {
      rangeEnd = index;
      continue;
    }
    ranges.push(
      rangeStart === rangeEnd
        ? (WEEKDAY_LABELS[rangeStart] ?? "")
        : `${WEEKDAY_LABELS[rangeStart]}–${WEEKDAY_LABELS[rangeEnd]}`,
    );
    rangeStart = index;
    rangeEnd = index;
  }
  ranges.push(
    rangeStart === rangeEnd
      ? (WEEKDAY_LABELS[rangeStart] ?? "")
      : `${WEEKDAY_LABELS[rangeStart]}–${WEEKDAY_LABELS[rangeEnd]}`,
  );
  return ranges.join(", ");
}

interface WeeklyWindowGroup {
  days: TemporalWeekday[];
  phase: TemporalModelPhase;
  windows: TemporalLocalWeeklyWindow[];
}

/**
 * One line per local weekday set and phase: identical weekdays share their
 * ranges, while a different day set or phase gets its own line.
 */
function groupWeeklyWindows(schedule: TemporalWeeklyScheduleDescription): WeeklyWindowGroup[] {
  const groups = new Map<string, WeeklyWindowGroup>();
  for (const window of schedule.windows) {
    const key = `${window.days.join(",")}|${window.phase}`;
    const existing = groups.get(key);
    if (existing) {
      existing.windows.push(window);
      continue;
    }
    groups.set(key, { days: window.days, phase: window.phase, windows: [window] });
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.windows.sort(
      (left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute,
    );
  }
  return result.sort(
    (left, right) =>
      WEEKDAY_ORDER.indexOf(left.days[0] ?? "mon") -
        WEEKDAY_ORDER.indexOf(right.days[0] ?? "mon") ||
      (left.windows[0]?.startMinute ?? 0) - (right.windows[0]?.startMinute ?? 0) ||
      left.phase.localeCompare(right.phase),
  );
}

function DatedSchedule(props: {
  schedule: TemporalDatedSchedule;
  effectVaries: boolean;
  nowMs: number;
  formatOptions?: TemporalFormatOptions;
}): JSX.Element {
  return (
    <div class="qg-temporal-popover__schedule">
      <For each={props.schedule.intervals}>
        {(interval) => {
          // The summary already states the active window's effect. Repeating it
          // on the active row would add noise; future windows keep their labels.
          const active = props.nowMs >= interval.startMs && props.nowMs < interval.endMs;
          return (
            <span class="qg-temporal-popover__interval">
              <span data-phase={interval.phase}>{temporalModelPhaseLabel(interval.phase)}</span>
              <span class="qg-temporal-popover__time">
                {formatLocalInterval(interval.startMs, interval.endMs, props.formatOptions)}
              </span>
              <Show when={props.effectVaries && !active && interval.effect}>
                {(effect) => (
                  <span class="qg-temporal-popover__effect">{temporalEffectLabel(effect())}</span>
                )}
              </Show>
            </span>
          );
        }}
      </For>
      <Show when={props.schedule.localClockChanges}>
        <span class="qg-temporal-popover__schedule-note">
          Local clock changes; showing exact dates.
        </span>
      </Show>
    </div>
  );
}

function WeeklySchedule(props: {
  schedule: TemporalWeeklyScheduleDescription;
  formatOptions?: TemporalFormatOptions;
}): JSX.Element {
  const groups = () => groupWeeklyWindows(props.schedule);
  const ranges = (group: WeeklyWindowGroup): string =>
    group.windows
      .map((window) => formatClockRange(window.startMinute, window.endMinute, props.formatOptions))
      .join(", ");
  return (
    <div class="qg-temporal-popover__schedule qg-temporal-popover__schedule--weekly">
      <Show
        when={groups().length > 0}
        fallback={
          <span class="qg-temporal-popover__schedule-line">
            {temporalModelPhaseLabel(props.schedule.basePhase)} all week
          </span>
        }
      >
        <For each={groups()}>
          {(group) => (
            <span class="qg-temporal-popover__schedule-line">
              <span data-phase={group.phase}>{temporalModelPhaseLabel(group.phase)}</span>
              {`: ${formatWeekdayList(group.days)} · ${ranges(group)}`}
            </span>
          )}
        </For>
      </Show>
    </div>
  );
}

function ModelSchedule(props: {
  schedule: TemporalScheduleDescription;
  effectVaries: boolean;
  nowMs: number;
  formatOptions?: TemporalFormatOptions;
}): JSX.Element {
  const weekly = () => (props.schedule.kind === "weekly" ? props.schedule : undefined);
  const dated = () => (props.schedule.kind === "dates" ? props.schedule : undefined);
  return (
    <>
      <Show when={weekly()}>
        {(schedule) => <WeeklySchedule schedule={schedule()} formatOptions={props.formatOptions} />}
      </Show>
      <Show when={dated()}>
        {(schedule) => (
          <DatedSchedule
            schedule={schedule()}
            effectVaries={props.effectVaries}
            nowMs={props.nowMs}
            formatOptions={props.formatOptions}
          />
        )}
      </Show>
    </>
  );
}

function TemporalModelDetail(props: {
  group: TemporalModelGroup;
  nowMs?: number;
  formatOptions?: TemporalFormatOptions;
}): JSX.Element {
  const now = () => props.nowMs ?? Date.now();
  const model = () => props.group.models[0] as TemporalModelStatus;
  const state = () => temporalModelStateAt(model(), now());
  const next = () => temporalModelNextChange(model(), now());
  const schedule = () => describeTemporalSchedule(model(), now(), props.formatOptions);
  // Schedule-only: decides whether each dated window needs its own effect label.
  // The current multiplier comes from the live interval and never from this
  // comparison across future windows.
  const effectVaries = () => {
    const current = schedule();
    return current.kind === "weekly" ? current.effectVaries : temporalEffectVaries(model(), now());
  };
  const hasSchedule = () => {
    const current = schedule();
    return current.kind === "weekly" || upcomingTemporalIntervals(model(), now()).length > 0;
  };
  const modelLabel = () => {
    const ids = props.group.models.map((entry) => entry.modelId);
    if (ids.length === 1) return ids[0] ?? "";
    const shown = ids.slice(0, 3).join(", ");
    const more = ids.length > 3 ? `, +${ids.length - 3} more` : "";
    return `${ids.length} models · ${shown}${more}`;
  };
  const effectLabel = () => temporalEffectLabel(state().effect);
  const nextLabel = () => {
    const change = next();
    return change === undefined
      ? undefined
      : `${nextChangeLabel(change.phase, state().state)} in ${formatTemporalCountdown(
          now(),
          change.atMs,
        )}`;
  };
  return (
    <section class="qg-temporal-popover__model">
      <div class="qg-temporal-popover__model-line">
        <span class="qg-temporal-popover__model-id">{modelLabel()}</span>
        <span class="qg-temporal-popover__state" data-phase={state().state}>
          {temporalModelPhaseLabel(state().state)}
        </span>
      </div>
      {/* The current scalar comes from the live interval only; future windows
          are never compared to infer it. Effect and next change share one
          compact line when both are available. */}
      <Show when={effectLabel() !== undefined || nextLabel() !== undefined}>
        <div class="qg-temporal-popover__summary">
          <Show when={effectLabel()}>
            {(label) => <span class="qg-temporal-popover__effect">{label()}</span>}
          </Show>
          <Show when={effectLabel() !== undefined && nextLabel() !== undefined}>
            <span class="qg-temporal-popover__separator" aria-hidden="true">
              {" • "}
            </span>
          </Show>
          <Show when={nextLabel()}>
            {(label) => <span class="qg-temporal-popover__next">{label()}</span>}
          </Show>
        </div>
      </Show>
      <Show when={state().reason}>
        {(reason) => <span class="qg-temporal-popover__reason">{reason()}</span>}
      </Show>
      <Show when={hasSchedule()}>
        <ModelSchedule
          schedule={schedule()}
          effectVaries={effectVaries()}
          nowMs={now()}
          formatOptions={props.formatOptions}
        />
      </Show>
    </section>
  );
}

/** Full detail body shared by Quota and Settings. */
export function TemporalPopoverBody(props: {
  status: TemporalProviderStatus;
  /** Test seam so a rendered DST/fallback case is deterministic. */
  nowMs?: number;
  formatOptions?: TemporalFormatOptions;
}): JSX.Element {
  const now = () => props.nowMs ?? Date.now();
  const phase = () => temporalProviderPhaseAt(props.status, now());
  const label = () => temporalProviderLabel(props.status);
  const holiday = () => nearestTemporalHoliday(props.status.holidays, now());
  const groups = () => groupTemporalModels(props.status.models);
  return (
    <div class="qg-temporal-popover__body">
      <header class="qg-temporal-popover__head">
        <ProviderLogo providerId={props.status.providerId} class="qg-temporal-popover__logo" />
        <span class="qg-temporal-popover__provider">{label()}</span>
        <span class="qg-temporal-popover__phase" data-phase={phase()}>
          {temporalPhaseLabel(phase())}
        </span>
      </header>
      <Show when={!props.status.discovered}>
        <p class="qg-temporal-popover__note">No account discovered for this provider yet.</p>
      </Show>
      <For each={groups()}>
        {(group) => (
          <TemporalModelDetail
            group={group}
            nowMs={props.nowMs}
            formatOptions={props.formatOptions}
          />
        )}
      </For>
      <Show when={holiday()}>
        {(nearest) => (
          <section class="qg-temporal-popover__holidays">
            <span class="qg-temporal-popover__section-title">
              {isCurrentTemporalHoliday(nearest(), now()) ? "Current Holiday:" : "Next Holiday:"}
            </span>
            <span class="qg-temporal-popover__holiday">
              {formatTemporalHoliday(nearest(), props.formatOptions)}
            </span>
          </section>
        )}
      </Show>
      <Show
        when={
          props.status.models.length > 0 &&
          props.status.models.every(
            (model) => temporalModelStateAt(model, now()).state === "unknown",
          )
        }
      >
        <p class="qg-temporal-popover__note">
          The current peak or off-peak window is unavailable for these models.
        </p>
      </Show>
    </div>
  );
}

/** Compact Quota-header chip: provider mark plus independently coloured live arrows. */
export function TemporalProviderChip(props: { status: TemporalProviderStatus }): JSX.Element {
  const phase = () => temporalProviderPhaseAt(props.status, Date.now());
  const label = () => temporalProviderLabel(props.status);
  return (
    <InteractivePopover
      label={`${label()}: ${temporalPhaseLabel(phase())}. Show peak and off-peak details.`}
      panelLabel={`Peak and off-peak details for ${label()}`}
      triggerClass="qg-temporal__chip"
      contentClass="qg-temporal-popover"
      placement="bottom-start"
      content={<TemporalPopoverBody status={props.status} />}
    >
      <span class="qg-temporal__chip-body" aria-hidden="true">
        <ProviderLogo providerId={props.status.providerId} class="qg-temporal__logo" />
        <span class="qg-temporal__arrows">{phaseIcon(phase())}</span>
      </span>
    </InteractivePopover>
  );
}

const STRIP_PHASES: readonly TemporalPhase[] = ["peak", "offpeak", "mixed", "unknown"];

/**
 * Compact Quota-header grouping. Providers are grouped by their conservative
 * live state, but the groups have no permanent text: only provider marks and
 * arrows. Explicit overrides win; otherwise a discovered account defaults on.
 */
export function TemporalStatusStrip(props: {
  providers: readonly TemporalProviderStatus[];
  overrides?: Readonly<Record<string, boolean>>;
}): JSX.Element {
  const visible = () =>
    props.providers.filter((provider) => {
      const override = props.overrides?.[provider.providerId];
      return typeof override === "boolean" ? override : provider.discovered;
    });
  const groups = () =>
    STRIP_PHASES.map((phase) => ({
      phase,
      providers: visible().filter(
        (provider) => temporalProviderPhaseAt(provider, Date.now()) === phase,
      ),
    })).filter((group) => group.providers.length > 0);

  return (
    <Show when={groups().length > 0}>
      <fieldset class="qg-temporal" aria-label="Temporal pricing status">
        <For each={groups()}>
          {(group) => (
            <div class="qg-temporal__group" data-phase={group.phase}>
              <div class="qg-temporal__chips">
                <For each={group.providers}>
                  {(provider) => <TemporalProviderChip status={provider} />}
                </For>
              </div>
            </div>
          )}
        </For>
      </fieldset>
    </Show>
  );
}

/** Settings-row affordance: the same interactive disclosure behind an info icon. */
export function TemporalInfoButton(props: { status: TemporalProviderStatus }): JSX.Element {
  return (
    <InteractivePopover
      label={`Peak and off-peak pricing details for ${temporalProviderLabel(props.status)}`}
      triggerClass="qg-row__info"
      contentClass="qg-temporal-popover"
      placement="bottom-end"
      content={<TemporalPopoverBody status={props.status} />}
    >
      <Icon name="info" size="small" />
    </InteractivePopover>
  );
}
