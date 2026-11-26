import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import { orderCardsByPreference } from "../../contracts/card-order";
import type { HomeSnapshot, ProjectActivityRow, QuotaSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { type DisplayPreferences, QuotaCardView } from "../components/quota-card";
import { SortControl } from "../components/sort-control";
import { EmptyNotice, ErrorCard, Skeleton } from "../components/states";
import { UsageChart } from "../components/usage-chart";
import {
  formatExactCount,
  formatTimestampMinutes,
  formatTokenCount,
  pluralize,
  usageChartTitle,
} from "../format";
import {
  createProjectChartComposition,
  type ProjectChartComposition,
} from "../project-composition";
import { formatPath } from "../routing";
import { sortProjectRows } from "../sorting";
import {
  describeEmptyActivity,
  describeNoProviders,
  usageHasActivity,
  visibleCards,
} from "../view-model";

/**
 * A row or chart hit surface that legitimately carries the composition handoff.
 * Focus/pointer leaving into one of these keeps the selected project for the
 * target's own handlers; anything else is an unrelated control.
 */
function isCompositionTarget(target: unknown): boolean {
  if (target === null || target === undefined) return false;
  const candidate = target as { closest?: (selector: string) => unknown };
  return (
    typeof candidate.closest === "function" &&
    candidate.closest("[data-composition-target]") !== null
  );
}

/**
 * Quota is the default independent surface. Analytics below uses the compatible
 * HomeSnapshot for usage and projects only; it never renders provider cards.
 *
 * Cards are one per provider account; the backend order is the fallback, and a
 * saved `dashboard.cardOrder`/`dashboard.providerOrder` preference re-orders the
 * already-received payload on render, so a live settings change needs no refetch.
 * Usage is the stacked area chart; projects are exactly two columns — name and
 * tokens — in the server's latest-activity order, which the frontend never re-sorts.
 */
export function QuotaView(props: {
  snapshot: QuotaSnapshot;
  preferences: DisplayPreferences;
  hiddenCards: string[];
  hiddenRows: string[];
  stale: boolean;
  onRetry?: () => void;
}): JSX.Element {
  const shown = () =>
    orderCardsByPreference(
      visibleCards(props.snapshot.providers.cards, props.hiddenCards),
      props.preferences.cardOrder,
      props.preferences.providerOrder,
    );

  return (
    <section class="qg-section qg-quota" id="qg-home-quota" aria-label="Quota">
      <Show
        when={shown().length > 0}
        fallback={
          props.snapshot.providers.cards.length === 0 && props.snapshot.stale ? (
            <ErrorCard
              message="Quota data is unavailable."
              retryable={props.onRetry !== undefined}
              onRetry={() => props.onRetry?.()}
            />
          ) : (
            <EmptyNotice
              message={
                props.snapshot.providers.cards.length > 0
                  ? "Every provider card is hidden. Use the eye toggles in Settings to bring one back."
                  : describeNoProviders(props.snapshot.providers.enabledProviders)
              }
            />
          )
        }
      >
        <div class="qg-card-grid">
          <For each={shown()}>
            {(card) => (
              <QuotaCardView
                card={card}
                preferences={props.preferences}
                hiddenRows={props.hiddenRows}
                stale={props.stale || card.stale === true}
                timeZone={props.snapshot.timeZone}
                nowMs={props.snapshot.providers.polledAtMs}
              />
            )}
          </For>
        </div>
      </Show>
      <footer class="qg-quota__meta">
        Polled{" "}
        {formatTimestampMinutes(props.snapshot.providers.polledAtMs, props.snapshot.timeZone)} ·{" "}
        {props.snapshot.providers.enabledProviders === "auto"
          ? "automatic provider selection"
          : pluralize(props.snapshot.providers.enabledProviders.length, "enabled provider")}
      </footer>
    </section>
  );
}

export function QuotaLoading(): JSX.Element {
  return (
    <section class="qg-section" aria-label="Quota">
      <div class="qg-card-grid">
        <Skeleton label="Loading providers" />
      </div>
    </section>
  );
}

export function HomeView(props: { snapshot: HomeSnapshot; range: RangeKey }): JSX.Element {
  const [sortMode, setSortMode] = createSignal<"activity" | "tokens">("activity");
  const projects = createMemo(() => sortProjectRows(props.snapshot.projects, sortMode()));
  // Transient, pointer/focus-owned composition. The four sources follow the
  // documented priority; the selected project survives between them so moving
  // from a row into the chart does not drop the overlay.
  const [pointerProject, setPointerProject] = createSignal<string>();
  const [focusedProject, setFocusedProject] = createSignal<string>();
  const [chartPointerProject, setChartPointerProject] = createSignal<string>();
  const [chartFocusProject, setChartFocusProject] = createSignal<string>();
  const [retainedProject, setRetainedProject] = createSignal<string>();

  const compositionFor = (project: ProjectActivityRow): ProjectChartComposition | undefined =>
    createProjectChartComposition(props.snapshot.usage, project);

  // The four live sources pick the project by the documented priority. The
  // retained id only bridges a row-to-chart hand-off, so a transient blur does
  // not drop the overlay before the chart's own pointer/focus arrives.
  const selectedProjectId = (): string | undefined =>
    pointerProject() ??
    focusedProject() ??
    chartPointerProject() ??
    chartFocusProject() ??
    retainedProject();

  const composition = createMemo(() => {
    const projectId = selectedProjectId();
    if (projectId === undefined) return undefined;
    const project = props.snapshot.projects.find((row) => row.projectId === projectId);
    return project === undefined ? undefined : compositionFor(project);
  });

  const highlightedProject = (): string | undefined =>
    composition() === undefined
      ? undefined
      : (pointerProject() ?? focusedProject() ?? chartPointerProject() ?? chartFocusProject());

  const activateProject = (project: ProjectActivityRow): boolean => {
    if (compositionFor(project) === undefined) return false;
    setRetainedProject(project.projectId);
    return true;
  };

  const onProjectPointerEnter = (project: ProjectActivityRow): void => {
    if (activateProject(project)) setPointerProject(project.projectId);
  };

  const onProjectFocus = (project: ProjectActivityRow): void => {
    if (activateProject(project)) setFocusedProject(project.projectId);
  };

  const releaseRetainedIfIdle = (): void => {
    if (
      pointerProject() === undefined &&
      focusedProject() === undefined &&
      chartPointerProject() === undefined &&
      chartFocusProject() === undefined
    ) {
      setRetainedProject(undefined);
    }
  };

  const onProjectPointerLeave = (project: ProjectActivityRow, event: PointerEvent): void => {
    setPointerProject((current) => (current === project.projectId ? undefined : current));
    if (isCompositionTarget(event.relatedTarget)) return;
    releaseRetainedIfIdle();
  };

  const onProjectBlur = (project: ProjectActivityRow, event: FocusEvent): void => {
    setFocusedProject((current) => (current === project.projectId ? undefined : current));
    if (isCompositionTarget(event.relatedTarget)) return;
    releaseRetainedIfIdle();
  };

  const onChartPointerChange = (projectId: string | undefined): void => {
    setChartPointerProject(projectId);
    if (projectId !== undefined) setRetainedProject(projectId);
    else releaseRetainedIfIdle();
  };

  const onChartFocusChange = (projectId: string | undefined): void => {
    setChartFocusProject(projectId);
    if (projectId !== undefined) setRetainedProject(projectId);
    else releaseRetainedIfIdle();
  };

  const clearPointerState = (): void => {
    setPointerProject(undefined);
    setChartPointerProject(undefined);
    releaseRetainedIfIdle();
  };

  const clearFocusState = (event: FocusEvent): void => {
    setFocusedProject(undefined);
    setChartFocusProject(undefined);
    if (isCompositionTarget(event.relatedTarget)) return;
    releaseRetainedIfIdle();
  };

  return (
    <div
      class="qg-home-composition"
      onPointerLeave={clearPointerState}
      onFocusOut={clearFocusState}
    >
      <Show
        when={props.snapshot.usage.buckets.length > 0}
        fallback={
          <section class="qg-section" aria-labelledby="qg-home-usage">
            <header class="qg-chart-shell__head">
              <h2 class="qg-section__title" id="qg-home-usage">
                {usageChartTitle(props.snapshot.usage.bucketUnit)}
              </h2>
            </header>
            <EmptyNotice message={describeEmptyActivity(usageHasActivity(props.snapshot.usage))} />
          </section>
        }
      >
        <UsageChart
          usage={props.snapshot.usage}
          headingId="qg-home-usage"
          composition={composition()}
          onCompositionPointerChange={onChartPointerChange}
          onCompositionFocusChange={onChartFocusChange}
        />
      </Show>

      <section class="qg-section" aria-labelledby="qg-home-projects">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-home-projects">
            Projects
          </h2>
          <SortControl label="projects" value={sortMode()} onChange={setSortMode} />
        </header>
        <Show
          when={props.snapshot.projects.length > 0}
          fallback={
            <EmptyNotice message="No activity in this range. Widen the range to see earlier projects." />
          }
        >
          <div class="qg-list">
            <div class="qg-list__head" aria-hidden="true">
              <span>Project</span>
              <span>Tokens</span>
            </div>
            <For each={projects()}>
              {(project) => {
                const highlighted = () => highlightedProject() === project.projectId;
                const dimmed = () => highlightedProject() !== undefined && !highlighted();
                const composable = compositionFor(project) !== undefined;
                return (
                  <a
                    class="qg-list__row"
                    data-composition-target={composable ? "row" : undefined}
                    data-clickable="true"
                    data-highlighted={highlighted() ? "true" : undefined}
                    data-dimmed={dimmed() ? "true" : undefined}
                    href={formatPath(
                      { name: "project", projectId: project.projectId },
                      props.range,
                    )}
                    onPointerEnter={() => onProjectPointerEnter(project)}
                    onPointerLeave={(event) => onProjectPointerLeave(project, event)}
                    onFocus={() => onProjectFocus(project)}
                    onBlur={(event) => onProjectBlur(project, event)}
                  >
                    <span class="qg-list__title" title={project.name}>
                      {project.name}
                    </span>
                    <span class="qg-list__tokens" title={formatExactCount(project.tokens.total)}>
                      {formatTokenCount(project.tokens.total)}
                    </span>
                  </a>
                );
              }}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}
