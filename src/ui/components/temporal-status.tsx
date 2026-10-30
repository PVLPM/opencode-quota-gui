import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type {
  TemporalModelStatus,
  TemporalPhase,
  TemporalProviderStatus,
} from "../../contracts/temporal";
import { Icon, Tooltip } from "../opencode-ui";
import { resolveProviderPresentation } from "../provider-catalog";
import {
  formatHolidayInterval,
  formatLocalInterval,
  formatTemporalCountdown,
  localZoneLabel,
  temporalEffectLabel,
  temporalModelNextChangeAt,
  temporalModelPhaseLabel,
  temporalModelStateAt,
  temporalPhaseLabel,
  temporalProviderNextChangeAt,
  temporalProviderPhaseAt,
  upcomingTemporalIntervals,
} from "../temporal-format";
import { OffpeakArrowIcon, PeakArrowIcon } from "./icons";
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
  if (phase === "peak") return <PeakArrowIcon />;
  if (phase === "offpeak") return <OffpeakArrowIcon />;
  if (phase === "mixed") {
    return (
      <>
        <PeakArrowIcon />
        <OffpeakArrowIcon />
      </>
    );
  }
  return (
    <span class="qg-temporal__unknown" aria-hidden="true">
      —
    </span>
  );
}

function TemporalModelDetail(props: { model: TemporalModelStatus }): JSX.Element {
  const now = () => Date.now();
  const state = () => temporalModelStateAt(props.model, now());
  const next = () => temporalModelNextChangeAt(props.model, now());
  const effect = () => temporalEffectLabel(state().effect);
  return (
    <section class="qg-temporal-popover__model">
      <div class="qg-temporal-popover__model-line">
        <span class="qg-temporal-popover__model-id">{props.model.modelId}</span>
        <span class="qg-temporal-popover__state" data-phase={state().state}>
          {temporalModelPhaseLabel(state().state)}
        </span>
      </div>
      <Show when={effect()}>
        {(label) => <span class="qg-temporal-popover__effect">{label()}</span>}
      </Show>
      <Show when={next()}>
        {(at) => (
          <span class="qg-temporal-popover__next">
            Next change in {formatTemporalCountdown(now(), at())}
          </span>
        )}
      </Show>
      <Show when={state().reason}>
        {(reason) => <span class="qg-temporal-popover__reason">{reason()}</span>}
      </Show>
      <Show when={upcomingTemporalIntervals(props.model, now()).length > 0}>
        <div class="qg-temporal-popover__schedule">
          <For each={upcomingTemporalIntervals(props.model, now())}>
            {(interval) => (
              <span class="qg-temporal-popover__interval">
                <span data-phase={interval.phase}>{temporalModelPhaseLabel(interval.phase)}</span>
                <span>{formatLocalInterval(interval.startMs, interval.endMs)}</span>
              </span>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

/** Full detail body shared by Quota and Settings. */
export function TemporalPopoverBody(props: { status: TemporalProviderStatus }): JSX.Element {
  const now = () => Date.now();
  const phase = () => temporalProviderPhaseAt(props.status, now());
  const label = () => temporalProviderLabel(props.status);
  return (
    <div class="qg-temporal-popover__body">
      <header class="qg-temporal-popover__head">
        <ProviderLogo providerId={props.status.providerId} class="qg-temporal-popover__logo" />
        <span class="qg-temporal-popover__provider">{label()}</span>
        <span class="qg-temporal-popover__phase" data-phase={phase()}>
          {temporalPhaseLabel(phase())}
        </span>
      </header>
      <p class="qg-temporal-popover__note">
        {props.status.source
          ? `Plan quota schedule · ${props.status.source.label}`
          : "models.dev schedule"}{" "}
        · times local to you ({localZoneLabel()})
      </p>
      <Show when={!props.status.discovered}>
        <p class="qg-temporal-popover__note">No account discovered for this provider yet.</p>
      </Show>
      <For each={props.status.models}>{(model) => <TemporalModelDetail model={model} />}</For>
      <Show when={props.status.holidays.length > 0}>
        <section class="qg-temporal-popover__holidays">
          <span class="qg-temporal-popover__section-title">Holiday exceptions</span>
          <For each={props.status.holidays.slice(0, 4)}>
            {(holiday) => (
              <span class="qg-temporal-popover__holiday">
                <span>{holiday.jurisdiction}</span>
                <span>{formatHolidayInterval(holiday)}</span>
              </span>
            )}
          </For>
        </section>
      </Show>
      <Show when={props.status.models.every((model) => model.state === "unknown")}>
        <p class="qg-temporal-popover__note">
          The pinned snapshot has no resolved peak or off-peak window for these routes.
        </p>
      </Show>
    </div>
  );
}

/** Compact Quota-header chip: provider mark plus the live peak/off-peak arrows. */
export function TemporalProviderChip(props: { status: TemporalProviderStatus }): JSX.Element {
  const phase = () => temporalProviderPhaseAt(props.status, Date.now());
  return (
    <Tooltip
      value={<TemporalPopoverBody status={props.status} />}
      triggerTabIndex={0}
      appearance="large"
      contentClass="qg-temporal-popover"
    >
      <span class="sr-only">
        {temporalProviderLabel(props.status)}: {temporalPhaseLabel(phase())}. Show peak and off-peak
        details.
      </span>
      <span class="qg-temporal__chip" data-phase={phase()} aria-hidden="true">
        <ProviderLogo providerId={props.status.providerId} class="qg-temporal__logo" />
        <span class="qg-temporal__arrows">{phaseIcon(phase())}</span>
      </span>
    </Tooltip>
  );
}

const STRIP_PHASES: readonly TemporalPhase[] = ["peak", "offpeak", "mixed", "unknown"];

/**
 * Compact Quota-header grouping. Providers are grouped by their live state,
 * but the groups have no permanent text: only provider marks and arrows.
 * Explicit overrides win; otherwise a discovered account defaults to visible.
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

/** Settings-row affordance: the same popover behind a focusable info icon. */
export function TemporalInfoButton(props: { status: TemporalProviderStatus }): JSX.Element {
  return (
    <Tooltip
      value={<TemporalPopoverBody status={props.status} />}
      triggerTabIndex={0}
      appearance="large"
      contentClass="qg-temporal-popover"
    >
      <span class="sr-only">
        Peak and off-peak pricing details for {temporalProviderLabel(props.status)}
      </span>
      <span class="qg-row__info" aria-hidden="true">
        <Icon name="info" size="small" />
      </span>
    </Tooltip>
  );
}

export function TemporalProviderSummary(props: { status: TemporalProviderStatus }): JSX.Element {
  const now = () => Date.now();
  const phase = () => temporalProviderPhaseAt(props.status, now());
  const next = () => temporalProviderNextChangeAt(props.status, now());
  const modelCount = () => props.status.models.length;
  return (
    <span class="qg-temporal__summary">
      <span data-phase={phase()}>{temporalPhaseLabel(phase())}</span>
      <span aria-hidden="true"> · </span>
      <span>
        {modelCount()} {modelCount() === 1 ? "model" : "models"}
      </span>
      <Show when={next()}>
        {(at) => <span> · changes in {formatTemporalCountdown(now(), at())}</span>}
      </Show>
    </span>
  );
}
