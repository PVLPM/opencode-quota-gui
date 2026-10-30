import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SettingsSnapshot } from "../src/contracts/dashboard.js";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import { settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";

/**
 * Settings row layout contract (issue #9).
 *
 * The label, help and provenance form one text column; the control has its own
 * column and stays anchored to the right while the text wraps independently.
 * Under 720px the same DOM order becomes a deliberate stack. The server render
 * below checks the real SettingsView markup, and the stylesheet checks pin the
 * responsive rules that a DOM-free render cannot measure.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");

interface SsrGraph {
  renderToString: (fn: () => unknown) => string;
  createComponent: (component: unknown, props: unknown) => unknown;
  load: (path: string) => Promise<Record<string, unknown>>;
}

interface SettingsModule {
  SettingsView: unknown;
}

let server: ViteDevServer | undefined;
let graph: SsrGraph;
let settingsModule: SettingsModule;

beforeAll(async () => {
  const created = await createServer({
    configFile: false,
    root: path.join(repoRoot, "src/ui"),
    plugins: [
      // Settings imports the public tooltip, whose client portal is not part of
      // this server-render check.
      {
        name: "tooltip-ssr-boundary",
        enforce: "pre",
        transform(_code, id) {
          if (id.replaceAll("\\", "/").endsWith("/overlays/tooltip/tooltip.tsx"))
            return "export function Tooltip(props) { return props.children }";
        },
      },
      solid({ include: [...SOLID_JSX_SOURCES], ssr: true }),
    ],
    resolve: {
      dedupe: ["solid-js", "solid-js/web", "solid-js/store", "@solidjs/meta"],
    },
    ssr: { noExternal: ["@opencode/ui"] },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  server = created;
  const web = (await created.ssrLoadModule("solid-js/web")) as {
    renderToString: SsrGraph["renderToString"];
  };
  const core = (await created.ssrLoadModule("solid-js")) as {
    createComponent: SsrGraph["createComponent"];
  };
  graph = {
    renderToString: web.renderToString,
    createComponent: core.createComponent,
    load: (modulePath) => created.ssrLoadModule(modulePath) as Promise<Record<string, unknown>>,
  };
  settingsModule = (await graph.load("/views/settings.tsx")) as unknown as SettingsModule;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

function renderSettings(snapshot: SettingsSnapshot): string {
  return graph.renderToString(() =>
    graph.createComponent(settingsModule.SettingsView, {
      snapshot,
      client: {},
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: { cards: [] },
      onReload: async () => {},
    }),
  );
}

/** The whole `.qg-field` row that owns an exact label, without its neighbours. */
function fieldRow(html: string, label: string): string {
  const labelAt = html.indexOf(`<span class="qg-field__label">${label}</span>`);
  if (labelAt === -1) throw new Error(`settings row "${label}" was not rendered`);
  const start = html.lastIndexOf("<div", labelAt);
  if (start === -1) throw new Error(`settings row "${label}" has no wrapper`);
  const next = html.indexOf('<div class="qg-field"', labelAt);
  return html.slice(start, next === -1 ? undefined : next);
}

/** First exact CSS rule body for a selector; an absent selector is an empty body. */
function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s").exec(source);
  return match?.[1] ?? "";
}

/** Bodies of every `@media <query>` block, nested braces included. */
function mediaBlocks(source: string, query: string): string[] {
  const needle = `@media ${query}`;
  const blocks: string[] = [];
  let start = source.indexOf(needle);
  while (start !== -1) {
    const open = source.indexOf("{", start);
    if (open === -1) break;
    let depth = 0;
    let cursor = open;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(open + 1, cursor));
    start = source.indexOf(needle, cursor);
  }
  return blocks;
}

describe("Settings row composition", () => {
  it("keeps the helper and provenance in a text column before the switch control", async () => {
    const html = renderSettings(
      settingsSnapshot({
        provenance: { waitForQuotaReset: { scope: "workspace" } },
        import: { available: false, issues: [] },
      }),
    );
    const row = fieldRow(html, "Wait for quota reset");
    const text = row.indexOf('<div class="qg-field__text">');
    const control = row.indexOf('<div class="qg-field__control">');

    expect(text).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(text);
    const textColumn = row.slice(text, control);
    expect(textColumn).toContain('<span class="qg-field__label">Wait for quota reset</span>');
    expect(textColumn).toContain("Hold requests until the quota window resets");
    expect(textColumn).toContain('<span class="qg-field__meta">');
    expect(textColumn).toContain("Workspace override");
    // The control column owns only the interactive control and its state label.
    const controlColumn = row.slice(control);
    expect(controlColumn).toContain('role="switch"');
    expect(controlColumn).not.toContain("Hold requests until the quota window resets");
    expect(controlColumn).not.toContain("Workspace override");
  });

  it("keeps a long select helper in the text column and the select right-anchored", async () => {
    const html = renderSettings(
      settingsSnapshot({
        provenance: { percentLabelStyle: { scope: "project" } },
        import: { available: false, issues: [] },
      }),
    );
    const row = fieldRow(html, "Label style");
    const text = row.indexOf('<div class="qg-field__text">');
    const control = row.indexOf('<div class="qg-field__control">');

    expect(text).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(text);
    const textColumn = row.slice(text, control);
    expect(textColumn).toContain('<span class="qg-field__label">Label style</span>');
    expect(textColumn).toContain("Full includes used or remaining beside the percentage");
    expect(textColumn).toContain("Project override");
    const controlColumn = row.slice(control);
    expect(controlColumn).toContain("<select");
    expect(controlColumn).toContain('aria-label="Label style"');
    expect(controlColumn).not.toContain("Full includes used or remaining beside the percentage");
    expect(controlColumn).not.toContain("Project override");
  });

  it("uses the same text-then-control order for the read-only dashboard rows", async () => {
    const html = renderSettings(settingsSnapshot({ import: { available: false, issues: [] } }));

    for (const label of ["Address", "Settings file"]) {
      const row = fieldRow(html, label);
      const text = row.indexOf('<div class="qg-field__text">');
      const control = row.indexOf('<div class="qg-field__control">');
      expect(text).toBeGreaterThan(-1);
      expect(control).toBeGreaterThan(text);
      expect(row.slice(text, control)).toContain(`<span class="qg-field__label">${label}</span>`);
    }

    // Existing accessible names and relationships survive the composition change.
    expect(html).toContain('aria-label="Dashboard address"');
    expect(html).toContain('aria-describedby="qg-settings-file-help"');
    expect(html).toContain('id="qg-settings-file-help"');
  });
});

describe("Settings row responsive contract", () => {
  it("anchors the control in its own right column and lets text wrap independently", () => {
    const field = cssRule(styles, ".qg-field");
    expect(field).toContain("grid-template-columns: minmax(0, 1fr) minmax(220px, 320px)");
    expect(field).toContain("align-items: start");

    const text = cssRule(styles, ".qg-field__text");
    expect(text).toContain("display: flex");
    expect(text).toContain("flex-direction: column");
    expect(text).toContain("min-width: 0");

    const control = cssRule(styles, ".qg-field > .qg-field__control");
    expect(control).toContain("justify-content: flex-end");
    expect(control).toContain("min-width: 0");

    const meta = cssRule(styles, ".qg-field__meta");
    expect(meta).not.toContain("grid-column: 2");
    expect(meta).toContain("overflow-wrap: anywhere");
  });

  it("keeps text inputs and selects inside the control column without clipping", () => {
    const input = cssRule(styles, ".qg-field__control > .qg-input");
    expect(input).toContain("min-width: 0");
    expect(input).toContain("max-width: 100%");
  });

  it("switches to a deliberate single-column stack below 720px", () => {
    const compact = mediaBlocks(styles, "(max-width: 720px)").join("\n");
    const field = cssRule(compact, ".qg-field");
    expect(field).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(field).not.toContain("minmax(220px, 320px)");

    const control = cssRule(compact, ".qg-field > .qg-field__control");
    expect(control).toContain("justify-content: flex-start");
  });
});
