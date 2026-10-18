import { createComponent, type JSX } from "solid-js";
import type { SettingsSnapshot } from "../../src/contracts/dashboard";
import { SettingsRoute } from "../../src/ui/app";
import type { Toaster } from "../../src/ui/components/toast";
import { type DashboardClient, DashboardError } from "../../src/ui/dashboard-client";
import type { VisibilityCatalog } from "../../src/ui/views/settings";

/**
 * The real `SettingsRoute` exactly as `App` wires it, with the query seam
 * replaced by the caller's accessors (design spec §10, §5.4; R14, R15).
 *
 * A render test can then flip a refetch's loading/data accessors and assert what
 * the route renders *next*, which is the only way to catch an editor that resets
 * its unsaved draft because the shell remounted it. Written with
 * `createComponent` rather than JSX so this file needs no compiler support of
 * its own; the components it renders are the shipped ones.
 */
export interface SettingsQuerySeam {
  data: () => SettingsSnapshot | undefined;
  error: () => unknown;
  loading: () => boolean;
  run: () => Promise<boolean>;
}

export function LiveSettingsRoute(props: {
  client: DashboardClient;
  query: SettingsQuerySeam;
  catalog: () => VisibilityCatalog;
  toaster: Toaster;
  stale: () => boolean;
}): JSX.Element {
  return createComponent(SettingsRoute, {
    client: props.client,
    query: props.query,
    get catalog() {
      return props.catalog();
    },
    toaster: props.toaster,
    get stale() {
      return props.stale();
    },
  });
}

/**
 * A `config-changed` failure built on the same module instance `SettingsView`
 * checks with `instanceof`. The test file's own import of the client is a
 * different module graph, so a locally built error would not be recognized.
 */
export function configChangedError(): DashboardError {
  return new DashboardError("config-changed", 409, "The settings file changed elsewhere.");
}
