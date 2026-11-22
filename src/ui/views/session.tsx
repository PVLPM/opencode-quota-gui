import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { SessionNode, SessionSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { cacheHitRate } from "../chart-geometry";
import { InteractivePopover } from "../components/interactive-popover";
import { SessionChart } from "../components/session-chart";
import { SortControl } from "../components/sort-control";
import {
  formatExactCount,
  formatModelIdentity,
  formatPercent,
  formatPercentExact,
  formatTokenCount,
} from "../format";
import { SegmentedControl, SegmentedControlItem } from "../opencode-ui";
import { formatPath } from "../routing";
import {
  defaultSessionScope,
  SESSION_SCOPES,
  type SessionScope,
  scopeSessionSnapshot,
} from "../session-scope";
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
            <span class="qg-node__model-text" title={formatModelIdentity(primary())}>
              {formatModelIdentity(primary())}
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
                      {(identity) => <li>{formatModelIdentity(identity)}</li>}
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
function SessionCacheRate(props: { tokens: SessionNode["ownTokens"] }): JSX.Element {
  const rate = () => cacheHitRate(props.tokens);
  return (
    <span class="qg-node__rate" title={formatPercentExact(rate())}>
      {rate() === null ? "—" : formatPercent(rate() ?? undefined)}
    </span>
  );
}

/**
 * Session page (design spec §10; R25–R27).
 *
 * Breadcrumbs carry the ancestors only — the current page is `aria-current`.
 * The focus session's own context and the tree's cumulative consumption stay
 * separate series. The session tree is an aligned Name | Agent | Model |
 * Cache Rate | Tokens table showing each session's own values; ordering
 * changes siblings only, so a parent always stays above its descendants.
 */
export function SessionView(props: {
  snapshot: SessionSnapshot;
  range: RangeKey;
  stale?: boolean;
}): JSX.Element {
  const [visibleNodes, setVisibleNodes] = createSignal(NODE_PAGE_SIZE);
  const [sortMode, setSortMode] = createSignal<"activity" | "tokens">("activity");
  const nodes = createMemo(() => sortSessionTree(props.snapshot.nodes, sortMode()));
  const windowed = () => nodes().slice(0, visibleNodes());
  const focusedNode = createMemo(() =>
    props.snapshot.nodes.find((node) => node.sessionId === props.snapshot.focusSessionId),
  );
  // The scope choice belongs to one focused session; opening another resets to its default.
  const [override, setOverride] = createSignal<{ id: string; scope: SessionScope }>();
  const scope = (): SessionScope => {
    const chosen = override();
    return chosen?.id === props.snapshot.focusSessionId
      ? chosen.scope
      : defaultSessionScope(props.snapshot);
  };
  const chartSnapshot = createMemo(() => scopeSessionSnapshot(props.snapshot, scope()));
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
                  fallback={<span aria-current="page">{crumb.title}</span>}
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
          <h2 class="qg-page-title" id="qg-session-head">
            {props.snapshot.breadcrumbs.find((crumb) => crumb.isFocus)?.title ??
              props.snapshot.focusSessionId}
          </h2>
          <Show when={props.snapshot.nodes.length > 1}>
            <SegmentedControl
              class="qg-sort"
              aria-label="Session chart scope"
              value={scope()}
              onChange={(value) => {
                if (value === "main" || value === "tree")
                  setOverride({ id: props.snapshot.focusSessionId, scope: value });
              }}
            >
              <For each={SESSION_SCOPES}>
                {(entry) => (
                  <SegmentedControlItem value={entry.value}>{entry.label}</SegmentedControlItem>
                )}
              </For>
            </SegmentedControl>
          </Show>
        </header>
        <SessionChart snapshot={chartSnapshot()} headingId="qg-session-usage" />
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
              {(node) => (
                // The row is a plain container so the "+N" disclosure is not
                // nested inside a link; the name link stretches over the row.
                <div
                  class="qg-node"
                  data-focus={node.sessionId === props.snapshot.focusSessionId ? "true" : undefined}
                >
                  <a
                    class="qg-node__link"
                    href={formatPath({ name: "session", sessionId: node.sessionId }, props.range)}
                    aria-current={
                      node.sessionId === props.snapshot.focusSessionId ? "page" : undefined
                    }
                    onClick={(event) => {
                      // The focused row is the scope control for its own session.
                      if (node.sessionId !== props.snapshot.focusSessionId) return;
                      event.preventDefault();
                      setOverride({ id: node.sessionId, scope: "main" });
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
                  <SessionCacheRate tokens={node.ownTokens} />
                  <span
                    class="qg-list__tokens qg-node__tokens"
                    title={formatExactCount(node.ownTokens.total)}
                  >
                    {formatTokenCount(node.ownTokens.total)}
                  </span>
                </div>
              )}
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
