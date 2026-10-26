import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { BUILD_IDENTITY } from "../../contracts/build-identity";
import { DASHBOARD_CONTRACT_VERSION } from "../../contracts/dashboard";
import type { DashboardRestartState } from "../dashboard-restart";

export interface RestartDashboardProps {
  restartState: DashboardRestartState;
  onRestart: () => void;
}

export function RestartDashboardAction(props: RestartDashboardProps): JSX.Element {
  return (
    <>
      <button
        type="button"
        class="qg-input"
        disabled={props.restartState === "restarting"}
        onClick={() => props.onRestart()}
      >
        {props.restartState === "restarting" ? "Restarting dashboard…" : "Restart dashboard"}
      </button>
      <output>
        {props.restartState === "failed"
          ? "Couldn’t restart the dashboard. Try again, or restart OpenCode once."
          : ""}
      </output>
    </>
  );
}

/**
 * Build identity presentation (design spec §7).
 *
 * The browser bundle and the packed server are stamped from one build-time
 * literal. These two pieces only present that public metadata: the shell decides
 * whether the running server differs, and Settings names the version, build and
 * contract actually embedded in this page.
 */

/** Compact, non-blocking restart hint. Quota stays usable underneath. */
export function BuildMismatchStatus(
  props: { message: string | undefined } & RestartDashboardProps,
): JSX.Element {
  return (
    <>
      <Show when={props.message}>
        {(message) => (
          <output
            class="qg-badge"
            title="This page and the running dashboard come from different builds. Restart the dashboard to reconnect. If the mismatch remains, restart OpenCode once to load the installed build. Quota data still works."
          >
            {message()}
          </output>
        )}
      </Show>
      <Show when={props.message}>
        <RestartDashboardAction restartState={props.restartState} onRestart={props.onRestart} />
      </Show>
    </>
  );
}

/** Quiet metadata at the bottom of Settings; no status action is implied. */
export function BuildAbout(): JSX.Element {
  return (
    <section class="qg-group" aria-labelledby="qg-settings-about">
      <h2 class="qg-group__title" id="qg-settings-about">
        About OpenCode Quota GUI
      </h2>
      <div class="qg-inherited">
        {`Version ${BUILD_IDENTITY.version} · Build ${BUILD_IDENTITY.build} · Contract ${DASHBOARD_CONTRACT_VERSION}`}
      </div>
    </section>
  );
}
