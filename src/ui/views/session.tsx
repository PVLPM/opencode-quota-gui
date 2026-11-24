import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { ModelIdentity, SessionNode, SessionSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { cacheHitRate } from "../chart-geometry";
import { InteractivePopover } from "../components/interactive-popover";
import { ModelIdentityLabel } from "../components/model-identity";
import { SessionChart } from "../components/session-chart";
import { SessionModelStrip } from "../components/session-model-strip";
import { SortControl } from "../components/sort-control";
import {
  formatExactCount,
  formatModelIdentity,
  formatPercentExact,
  formatTokenCount,
} from "../format";
import { formatPath } from "../routing";
import { focusSessionSnapshot } from "../session-scope";
import { sortSessionTree } from "../sorting";

/** Very large trees are windowed for rendering only; totals and both graphs always cover every node. */
const NODE_PAGE_SIZE = 200;

/** The last-used identity, plus a disclosure of every distinct identity when there are several. */
function SessionModelCell(props: { models: SessionNode["models"] }): JSX.Element {
  return (
    <span class="qg-node__model">
      <Show when={props.models[0]} fallback="—">
        {(primary) => (
          <>
            <span class="qg-node__model-text">
              <ModelIdentityLabel identity={primary()} />
            </span>
            <Show when={props.models.length > 1}>
              <InteractivePopover
                label={`${props.models.length - 1} more model configurations. Show all ${props.models.length}.`}
                panelLabel="Model configurations used by this session, most recently used first"
                triggerClass="qg-node__more"
                contentClass="qg-temporal-popover"
                placement="bottom-start"
                content={
                  <ol class="qg-node__model-list">
                    <For each={props.models}>
                      {(identity) => (
                        <li>
                          <ModelIdentityLabel identity={identity} />
                        </li>
                      )}
                    </For>
                  </ol>
                }
              >
                +{props.models.length - 1}
              </InteractivePopover>
            </Show>
          </>
        )}
      </Show>
    </span>
  );
}

/** The session's own token-weighted cache rate; unavailable traffic stays a dash, never 0%. */
function SessionCacheRate(props: { node: SessionNode }): JSX.Element {
  // Missing cache counters made the zero unknown: no rate, never a manufactured 0%.
  const unknown = () => (props.node.cacheUnknownSteps ?? 0) > 0;
  const rate = () => (unknown() ? null : cacheHitRate(props.node.ownTokens));
  return (
    <span
      class="qg-node__rate"
      title={
        unknown()
          ? `Unknown: cache counters were not recorded for ${props.node.cacheUnknownSteps} step(s)`
          : formatPercentExact(rate())
      }
    >
      {rate() === null ? "—" : formatPercentExact(rate())}
    </span>
  );
}

/** A pointer must travel this far before its click counts as a drag-select. */
const DRAG_SELECT_DISTANCE = 4;

/** Where a row's current press started; `undefined` until it is pressed. */
type RowPointerStart = { x: number; y: number } | undefined;

/**
 * True only for a pointer drag that selected text inside this row. A plain
 * click, a selection made anywhere else, and keyboard activation all navigate:
 * `detail` is 0 for a click the browser synthesizes without a pointer.
 */
function rowDragSelectionBlocksNavigation(
  event: MouseEvent & { currentTarget: Element },
  start: RowPointerStart,
): boolean {
  if (event.detail === 0 || start === undefined) return false;
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= DRAG_SELECT_DISTANCE)
    return false;
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (selection === null || selection.isCollapsed || selection.toString() === "") return false;
  const row = event.currentTarget.closest(".qg-node");
  const anchor = selection.anchorNode;
  return row !== null && anchor !== null && row.contains(anchor);
}

/**
 * Session page (design spec §10; R25–R27).
 *
 * Breadcrumbs carry the ancestors only — the current page is `aria-current`.
 * The project chart shows the main session's own steps with the tree cumulative
 * aligned to them; every other session opens its own individual chart. The
 * session tree is an aligned Name | Agent | Model | Cache Rate | Tokens table
 * showing each session's own values; ordering changes siblings only, so a parent
 * always stays above its descendants.
 */
export function SessionView(props: {
  snapshot: SessionSnapshot;
  range: RangeKey;
  /** Open this session's own analytics even when it is a project root. */
  individual?: boolean;
  stale?: boolean;
}): JSX.Element {
  const [visibleNodes, setVisibleNodes] = createSignal(NODE_PAGE_SIZE);
  const [sortMode, setSortMode] = createSignal<"activity" | "tokens">("activity");
  const nodes = createMemo(() => sortSessionTree(props.snapshot.nodes, sortMode()));
  const windowed = () => nodes().slice(0, visibleNodes());
  const focusedNode = createMemo(() =>
    props.snapshot.nodes.find((node) => node.sessionId === props.snapshot.focusSessionId),
  );
  /** The root's own individual view; only it needs a breadcrumb back to the tree chart. */
  const individualRoot = () => props.individual === true && focusedNode()?.parentId === undefined;
  /** A project root owns the main chart unless the individual view is explicitly requested. */
  const variant = (): "main" | "focus" =>
    props.individual === true || focusedNode()?.parentId !== undefined ? "focus" : "main";
  // The individual chart never accounts for descendants, in its series or scale.
  const chartSnapshot = createMemo(() =>
    variant() === "main" ? props.snapshot : focusSessionSnapshot(props.snapshot),
  );
  /**
   * The charted models in first-use order for an individual/subsession header.
   * Only consecutive repeats collapse, so a model that returns later is listed
   * again; the main project chart header never carries this line.
   */
  const headerModelIdentities = createMemo(() => {
    if (variant() !== "focus") return [];
    const identities: ModelIdentity[] = [];
    let previous: string | undefined;
    for (const step of chartSnapshot().steps) {
      if (!step.model) continue;
      const identity = formatModelIdentity(step.model);
      if (identity === previous) continue;
      previous = identity;
      identities.push(step.model);
    }
    return identities;
  });
  /** The focused root's row opens its individual view; every other row keeps its own page. */
  const sessionHref = (sessionId: string): string =>
    formatPath(
      sessionId === props.snapshot.focusSessionId &&
        (variant() === "main" || props.individual === true)
        ? { name: "session", sessionId, individual: true }
        : { name: "session", sessionId },
      props.range,
    );
  // A focused child with no descendants adds no information beyond its own
  // chart; a root session and any child with descendants keep the tree.
  const showTree = createMemo(() => {
    const focus = focusedNode();
    return focus === undefined || !(focus.parentId && props.snapshot.nodes.length === 1);
  });

  return (
    <>
      <div class="qg-detail">
        <nav class="qg-breadcrumbs" aria-label="Breadcrumb">
          <a href={formatPath({ name: "analytics" }, props.range)}>Analytics</a>
          <span aria-hidden="true">›</span>
          <a
            href={formatPath({ name: "project", projectId: props.snapshot.projectId }, props.range)}
          >
            {props.snapshot.projectName}
          </a>
          <For each={props.snapshot.breadcrumbs}>
            {(crumb) => (
              <>
                <span aria-hidden="true">›</span>
                <Show
                  when={!crumb.isFocus}
                  fallback={
                    <Show
                      when={individualRoot()}
                      fallback={<span aria-current="page">{crumb.title}</span>}
                    >
                      <a
                        href={formatPath(
                          { name: "session", sessionId: crumb.sessionId },
                          props.range,
                        )}
                      >
                        {crumb.title}
                      </a>
                      <span aria-hidden="true">›</span>
                      <span aria-current="page">Individual view</span>
                    </Show>
                  }
                >
                  <a
                    href={formatPath({ name: "session", sessionId: crumb.sessionId }, props.range)}
                  >
                    {crumb.title}
                  </a>
                </Show>
              </>
            )}
          </For>
        </nav>

        <header class="qg-page-head">
          <div class="qg-page-head__heading">
            <h2 class="qg-page-title" id="qg-session-head">
              {props.snapshot.breadcrumbs.find((crumb) => crumb.isFocus)?.title ??
                props.snapshot.focusSessionId}
            </h2>
            <Show when={headerModelIdentities().length > 0}>
              <SessionModelStrip identities={headerModelIdentities()} />
            </Show>
          </div>
        </header>
        <SessionChart snapshot={chartSnapshot()} variant={variant()} headingId="qg-session-usage" />
      </div>

      <Show when={showTree()}>
        <section class="qg-section" aria-labelledby="qg-session-nodes">
          <header class="qg-section__head">
            <h2 class="qg-section__title" id="qg-session-nodes">
              Session tree
            </h2>
            <SortControl label="session tree" value={sortMode()} onChange={setSortMode} />
          </header>
          <div class="qg-nodes">
            <div class="qg-nodes__head" aria-hidden="true">
              <span>Name</span>
              <span>Agent</span>
              <span>Model</span>
              <span>Cache Rate</span>
              <span>Tokens</span>
            </div>
            <For each={windowed()}>
              {(node) => {
                // The row is a plain container so the "+N" disclosure is not
                // nested inside a link; the name link stretches over the row.
                // It remembers where its press began, so only a drag that
                // selected its own text suppresses navigation; a selection made
                // elsewhere (or a keyboard activation) still follows the link.
                let pointerStart: RowPointerStart;
                return (
                  <div
                    class="qg-node"
                    data-focus={
                      node.sessionId === props.snapshot.focusSessionId ? "true" : undefined
                    }
                    onPointerDown={(event) => {
                      pointerStart = { x: event.clientX, y: event.clientY };
                    }}
                  >
                    <a
                      class="qg-node__link"
                      href={sessionHref(node.sessionId)}
                      aria-current={
                        node.sessionId === props.snapshot.focusSessionId ? "page" : undefined
                      }
                      onClick={(event) => {
                        if (rowDragSelectionBlocksNavigation(event, pointerStart))
                          event.preventDefault();
                      }}
                    >
                      <span
                        class="qg-node__name"
                        title={node.title}
                        style={{ "--qg-node-depth": String(node.depth) }}
                      >
                        {node.title}
                      </span>
                    </a>
                    <span class="qg-node__agent">{node.agent?.trim() ? node.agent : "—"}</span>
                    <SessionModelCell models={node.models} />
                    <SessionCacheRate node={node} />
                    <span
                      class="qg-list__tokens qg-node__tokens"
                      title={formatExactCount(node.ownTokens.total)}
                    >
                      {formatTokenCount(node.ownTokens.total)}
                    </span>
                  </div>
                );
              }}
            </For>
          </div>
          <Show when={visibleNodes() < nodes().length}>
            <button
              type="button"
              class="qg-input"
              onClick={() => setVisibleNodes((count) => count + NODE_PAGE_SIZE)}
            >
              Show {Math.min(NODE_PAGE_SIZE, nodes().length - visibleNodes())} more nodes
            </button>
          </Show>{" "}
        </section>
      </Show>

      <p class="qg-footnote">{props.snapshot.stepSemantics}</p>
    </>
  );
}
