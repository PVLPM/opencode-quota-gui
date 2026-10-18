import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import type { SessionSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { SessionChart } from "../components/session-chart";
import { StaleNotice } from "../components/states";
import { formatExactCount, pluralize } from "../format";
import { formatHash } from "../routing";

/** Very large trees are windowed for rendering only; totals and both graphs always cover every node. */
const NODE_PAGE_SIZE = 200;

/**
 * Session page (design spec §10; R25–R27).
 *
 * Breadcrumbs carry the ancestors only — the current page is `aria-current` —
 * and the opened session's own usage is reported separately from the tree
 * total. The node list indents by `depth`, shows each node's own tokens as
 * secondary text, and links immediate children; the list may be windowed, while
 * the totals and both graphs always cover the whole tree.
 */
export function SessionView(props: {
  snapshot: SessionSnapshot;
  range: RangeKey;
  stale?: boolean;
}): JSX.Element {
  const [visibleNodes, setVisibleNodes] = createSignal(NODE_PAGE_SIZE);
  const nodes = () => props.snapshot.nodes;
  const windowed = () => nodes().slice(0, visibleNodes());
  const nodeById = (id: string) => nodes().find((node) => node.sessionId === id);

  return (
    <>
      <Show when={props.stale}>
        <StaleNotice message="Showing the last good snapshot for this session tree." />
      </Show>
      <nav class="qg-breadcrumbs" aria-label="Breadcrumb">
        <a href={formatHash({ name: "home" }, props.range)}>Home</a>
        <For each={props.snapshot.breadcrumbs}>
          {(crumb) => (
            <>
              <span aria-hidden="true">›</span>
              <Show when={!crumb.isFocus} fallback={<span aria-current="page">{crumb.title}</span>}>
                <a href={formatHash({ name: "session", sessionId: crumb.sessionId }, props.range)}>
                  {crumb.title}
                </a>
              </Show>
            </>
          )}
        </For>
      </nav>

      <section class="qg-section" aria-labelledby="qg-session-head">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-session-head">
            {props.snapshot.breadcrumbs.find((crumb) => crumb.isFocus)?.title ??
              props.snapshot.focusSessionId}
          </h2>
          <span class="qg-section__meta">
            own {pluralize(props.snapshot.ownSummary.total, "token")} · tree{" "}
            {pluralize(props.snapshot.treeTotals.total, "token")} over{" "}
            {pluralize(nodes().length, "node")}
          </span>
        </header>
        <SessionChart snapshot={props.snapshot} />
      </section>

      <section class="qg-section" aria-labelledby="qg-session-nodes">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-session-nodes">
            Session tree
          </h2>
          <span class="qg-section__meta">arbitrary depth · own tokens shown as secondary text</span>
        </header>
        <div class="qg-nodes">
          <For each={windowed()}>
            {(node) => (
              <div
                class="qg-node"
                data-focus={node.sessionId === props.snapshot.focusSessionId ? "true" : undefined}
                style={{ "padding-left": `${16 + node.depth * 16}px` }}
              >
                <div class="qg-node__main">
                  <span class="qg-node__title" title={node.title}>
                    <Show when={node.worktreeLabel}>
                      {(worktree) => <span class="qg-muted">{worktree()} · </span>}
                    </Show>
                    {node.title}
                  </span>
                  <span class="qg-node__own">
                    own {formatExactCount(node.ownTokens.total)} · subtree{" "}
                    {formatExactCount(node.subtreeTokens.total)} ·{" "}
                    {pluralize(node.stepCount, "step")}
                  </span>
                  <Show when={node.childIds.length > 0}>
                    <span class="qg-node__children">
                      <span class="qg-muted">children:</span>
                      <For each={node.childIds}>
                        {(childId) => (
                          <a
                            href={formatHash({ name: "session", sessionId: childId }, props.range)}
                          >
                            {nodeById(childId)?.title ?? childId}
                          </a>
                        )}
                      </For>
                    </span>
                  </Show>
                </div>
                <span class="qg-list__tokens" title={formatExactCount(node.subtreeTokens.total)}>
                  {formatExactCount(node.subtreeTokens.total)}
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

      <p class="qg-footnote">{props.snapshot.stepSemantics}</p>
    </>
  );
}
