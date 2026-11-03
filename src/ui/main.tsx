/**
 * Browser entry (design spec §11.1).
 *
 * Import order matters: the wrapper pulls in the library stylesheet first, so
 * the library's tokens and component styles lead the cascade and this
 * dashboard's own rules can only fill the gaps the library leaves. The
 * document-level resets come last: they describe the page, and the same
 * product stylesheet is injected into a foreign document by the native GUI.
 */
import "./opencode-ui";
import "./styles.css";
import "./base.css";

import { render } from "solid-js/web";
import { App } from "./app";
import { createHttpDashboardClient } from "./dashboard-client";

const root = document.getElementById("root");
if (root) {
  const client = createHttpDashboardClient();
  render(() => <App client={client} />, root);
}
