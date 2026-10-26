import type { JSX } from "solid-js";
import { Match, Show, Switch } from "solid-js";
import type { LoadState } from "../view-model";

/**
 * Shared state primitives (design spec §10 "States").
 *
 * First load is a skeleton, a refetch keeps the previous payload under a thin
 * progress line, section failures are local and retryable, and a stale payload
 * says so quietly with `aria-live="polite"`.
 */

/**
 * Presenter for one resolved section state.
 *
 * Both data branches are **keyed** on the resolved state object, and that is what
 * makes a section follow its payload. `Switch` calls a `Match` child inside
 * `untrack` and its non-keyed condition memo only compares truthiness, so a
 * non-keyed branch runs once — the view it builds keeps the very first payload
 * forever while the rest of the shell updates around it. A keyed `when` re-runs
 * the child whenever the state object is replaced, which is every time the query
 * (or a refetch after a reconnect) produces a new payload.
 */
export function QueryState<T>(props: {
  state: LoadState<T>;
  label: string;
  skeleton?: JSX.Element;
  render: (data: T, stale: boolean) => JSX.Element;
}): JSX.Element {
  const ready = () => (props.state.kind === "ready" ? props.state : undefined);
  const failed = () => (props.state.kind === "error" ? props.state : undefined);
  const reload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  return (
    <Switch>
      <Match when={props.state.kind === "skeleton"}>
        {props.skeleton ?? <Skeleton label={props.label} />}
      </Match>
      <Match keyed when={failed()}>
        {(state) => (
          <ErrorCard message={state.message} retryable={state.retryable} onRetry={reload} />
        )}
      </Match>
      <Match keyed when={ready()}>
        {(state) => props.render(state.data, state.stale)}
      </Match>
      <Match when={true}>{null}</Match>
    </Switch>
  );
}

export function Skeleton(props: { lines?: number; label?: string }): JSX.Element {
  const lines = () => props.lines ?? 3;
  return (
    <output class="qg-skeleton" aria-label={props.label ?? "Loading"} aria-busy="true">
      {Array.from({ length: lines() }, () => (
        <span class="qg-skeleton__line" aria-hidden="true" />
      ))}
    </output>
  );
}

export function EmptyNotice(props: { message: string; children?: JSX.Element }): JSX.Element {
  return (
    <div class="qg-empty">
      <span>{props.message}</span>
      {props.children}
    </div>
  );
}

export function ErrorCard(props: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div class="qg-error-card" role="alert">
      <span class="qg-error-card__message">{props.message}</span>
      <Show when={props.retryable}>
        <button type="button" class="qg-input" onClick={() => props.onRetry()}>
          Retry
        </button>
      </Show>
    </div>
  );
}

export function StaleNotice(props: { message: string }): JSX.Element {
  return (
    <p class="qg-stale" aria-live="polite">
      <span aria-hidden="true">●</span>
      {props.message}
    </p>
  );
}

export function ReloadRequired(props: { message: string }): JSX.Element {
  return (
    <div class="qg-reload" role="alert">
      <strong>This dashboard build is out of date</strong>
      <span>{props.message}</span>
    </div>
  );
}
