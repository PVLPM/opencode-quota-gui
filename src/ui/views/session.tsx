import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import type { SessionSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { SessionChart } from "../components/session-chart";
import { formatExactCount, pluralize } from "../format";
import { formatHash } from "../routing";

/** Very large trees are windowed for rendering only; totals and both graphs always cover every node. */
const NODE_PAGE_SIZE = 200;

/**
 * Session page (design spec §10; R25–R27).
 *
 * Breadcrumbs carry the ancestors only — the current page is `aria-current` —
 * and the opened session's own usage is reported separately from the tree
 * total. Each tree row is itself the link, so no separate child-link list is
 * rendered; the list indents by `depth`, shows each node's own tokens as
 * secondary text, and may be windowed, while the totals and both graphs always
 * cover the whole tree.
 */
export function SessionView(props: {
  snapshot: SessionSnapshot;
  range: RangeKey;
  stale?: boolean;
}): JSX.Element {
  const [visibleNodes, setVisibleNodes] = createSignal(NODE_PAGE_SIZE);
  const nodes = () => props.snapshot.nodes;
  const windowed = () => nodes().slice(0, visibleNodes());

  return (
    <>
      <nav class="qg-breadcrumbs" aria-label="Breadcrumb">
        <a href={formatHash({ name: "analytics" }, props.range)}>Analytics</a>
        <span aria-hidden="true">›</span>
        <a href={formatHash({ name: "project", projectId: props.snapshot.projectId }, props.range)}>
          {props.snapshot.projectName}
        </a>
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
          <span class="qg-section__meta">Own usage and descendant totals · UTC</span>
        </header>
        <div class="qg-nodes">
          <For each={windowed()}>
            {(node) => (
              <a
                class="qg-node"
                href={formatHash({ name: "session", sessionId: node.sessionId }, props.range)}
                aria-current={node.sessionId === props.snapshot.focusSessionId ? "page" : undefined}
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
                </div>
                <span class="qg-list__tokens" title={formatExactCount(node.subtreeTokens.total)}>
                  {formatExactCount(node.subtreeTokens.total)}
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

      <p class="qg-footnote">{props.snapshot.stepSemantics}</p>
    </>
  );
}
