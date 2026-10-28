import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { SessionSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { SessionChart } from "../components/session-chart";
import { SortControl } from "../components/sort-control";
import { formatExactCount, formatTokenCount } from "../format";
import { formatPath } from "../routing";
import { sortSessionTree } from "../sorting";

/** Very large trees are windowed for rendering only; totals and both graphs always cover every node. */
const NODE_PAGE_SIZE = 200;

/**
 * Session page (design spec §10; R25–R27).
 *
 * Breadcrumbs carry the ancestors only — the current page is `aria-current`.
 * The focus session's own context and the tree's cumulative consumption stay
 * separate series. The session tree is an aligned Name | Agent | Steps |
 * Tokens table; ordering changes siblings only, so a parent always stays above
 * its descendants. Totals and both graphs always cover the whole tree.
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
        </header>
        <SessionChart snapshot={props.snapshot} headingId="qg-session-usage" />
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
              <span>Steps</span>
              <span>Tokens</span>
            </div>
            <For each={windowed()}>
              {(node) => (
                <a
                  class="qg-node"
                  href={formatPath({ name: "session", sessionId: node.sessionId }, props.range)}
                  aria-current={
                    node.sessionId === props.snapshot.focusSessionId ? "page" : undefined
                  }
                  data-focus={node.sessionId === props.snapshot.focusSessionId ? "true" : undefined}
                >
                  <span
                    class="qg-node__name"
                    title={node.title}
                    style={{ "--qg-node-depth": String(node.depth) }}
                  >
                    {node.title}
                  </span>
                  <span class="qg-node__agent">{node.agent?.trim() ? node.agent : "—"}</span>
                  <span class="qg-node__steps">{formatExactCount(node.stepCount)}</span>
                  <span
                    class="qg-list__tokens qg-node__tokens"
                    title={formatExactCount(node.subtreeTokens.total)}
                  >
                    {formatTokenCount(node.subtreeTokens.total)}
                  </span>
                </a>
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
