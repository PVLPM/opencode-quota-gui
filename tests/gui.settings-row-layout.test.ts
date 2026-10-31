import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SettingsSnapshot } from "../src/contracts/dashboard.js";
import type { TemporalStatusSnapshot } from "../src/contracts/temporal.js";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import { settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";

/**
 * Settings row layout contract (issue #9).
 *
 * The label, help and provenance form one text column; the control has its own
 * column and stays anchored to the right while the text wraps independently.
 * The row responds to the width of its own group, not the window: a Settings
 * pane can be a narrow column on a wide screen. The server render below checks
 * the real SettingsView markup, the stylesheet checks pin the responsive rules,
 * and - when a local Chromium is available - a rendered copy measures both a
 * wide and a narrow row at the same viewport width.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");

/** A local Chromium makes the computed-layout check possible; CI may not have one. */
const layoutBrowser = [
  process.env.QG_LAYOUT_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));

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

function renderSettings(snapshot: SettingsSnapshot, temporal?: TemporalStatusSnapshot): string {
  return graph.renderToString(() =>
    graph.createComponent(settingsModule.SettingsView, {
      snapshot,
      client: {},
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: { cards: [] },
      temporal,
      onReload: async () => {},
    }),
  );
}

/** One discovered provider with a live phase and a pending transition. */
function layoutTemporal(): TemporalStatusSnapshot {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const effect = { factor: 1, direction: "unchanged" as const, unit: "quota_points" as const };
  return {
    generatedAtMs: now,
    providers: [
      {
        providerId: "zai",
        providerLabel: "Z.ai",
        discovered: true,
        phase: "offpeak",
        models: [
          {
            modelId: "glm-5",
            state: "offpeak",
            effect,
            nextChangeAtMs: now + 2 * 3_600_000,
            nextState: "peak",
            intervals: [
              {
                startMs: now - 3_600_000,
                endMs: now + 2 * 3_600_000,
                phase: "offpeak",
                effect,
              },
            ],
          },
        ],
        holidays: [],
      },
    ],
    snapshot: { revision: "layout-test", generatedAtMs: now },
  };
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

/** Bodies of every `@media`/`@container` block, nested braces included. */
function atRuleBlocks(source: string, atRule: string): string[] {
  const needle = `@${atRule}`;
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

  it("keeps the permanent temporal phase summary out of Settings", async () => {
    const html = renderSettings(
      settingsSnapshot({ import: { available: false, issues: [] } }),
      layoutTemporal(),
    );
    const rows = html.split('class="qg-field qg-temporal-settings__row"').slice(1);
    const row = rows.find((entry) => entry.includes("Show peak and off-peak pricing for Z.ai"));

    expect(row).toBeDefined();
    // The info affordance remains; the phase/model/countdown text does not.
    expect(row).toContain('aria-label="Peak and off-peak pricing details for Z.ai"');
    expect(row).not.toContain("qg-temporal__summary");
    expect(row).not.toContain("1 model");
    expect(html).not.toContain("qg-temporal__summary");

    if (row === undefined) throw new Error("temporal Settings row was not rendered");
    const text = row.indexOf('<div class="qg-field__text">');
    const control = row.indexOf('<div class="qg-field__control">');
    expect(text).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(text);
    expect(row.slice(text, control)).not.toContain('role="switch"');
    expect(row.slice(control)).not.toContain("No account discovered.");
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

  it("switches to a deliberate single-column stack when the row container is narrow", () => {
    const group = cssRule(styles, ".qg-group");
    expect(group).toContain("container-type: inline-size");
    expect(group).toContain("container-name: qg-settings-group");

    const compact = atRuleBlocks(styles, "container qg-settings-group (max-width: 540px)").join(
      "\n",
    );
    const field = cssRule(compact, ".qg-field");
    expect(field).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(field).not.toContain("minmax(220px, 320px)");

    const control = cssRule(compact, ".qg-field > .qg-field__control");
    expect(control).toContain("justify-content: flex-start");

    // The old viewport rule stacked rows that still had room for both columns.
    const viewport = atRuleBlocks(styles, "media (max-width: 720px)").join("\n");
    expect(viewport).not.toMatch(/\.qg-field\s*\{/);
  });
});

interface MeasuredRow {
  rowWidth: number;
  grid: string;
  textRight: number;
  controlLeft: number;
  controlWidth: number;
  trailingRightGap: number;
  controlLeftGap: number;
  stacked: boolean;
  sameLine: boolean;
  hasSummary: boolean;
}

interface MeasuredCopy {
  name: string;
  wait: MeasuredRow | null;
  temporal: MeasuredRow | null;
}

interface LayoutProbe {
  innerWidth: number;
  copies: MeasuredCopy[];
}

/**
 * One real Settings render copied into two fixed-width hosts. Both copies share
 * the harness viewport, so a viewport media query would force the same state on
 * both and fail the assertions below.
 */
function layoutHarness(settingsHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Settings layout probe</title><style>${styles}</style></head>
<body>
<div data-harness-copy="wide" style="width:700px">${settingsHtml}</div>
<div data-harness-copy="narrow" style="width:520px">${settingsHtml}</div>
<pre id="layout-result"></pre>
<script>
(() => {
  const measure = (row) => {
    const text = row.querySelector(".qg-field__text");
    const control = row.querySelector(".qg-field__control");
    const trailing = control.lastElementChild;
    const rr = row.getBoundingClientRect();
    const tr = text.getBoundingClientRect();
    const cr = control.getBoundingClientRect();
    const gr = trailing.getBoundingClientRect();
    return {
      rowWidth: rr.width,
      grid: getComputedStyle(row).gridTemplateColumns,
      textRight: tr.right,
      controlLeft: cr.left,
      controlWidth: cr.width,
      trailingRightGap: rr.right - gr.right,
      controlLeftGap: cr.left - rr.left,
      stacked: cr.top >= tr.bottom - 0.5,
      sameLine: Math.abs(tr.top - cr.top) < 2,
      hasSummary: Boolean(row.querySelector(".qg-temporal__summary")),
    };
  };
  const read = (root) => {
    const rows = [...root.querySelectorAll(".qg-field")];
    const wait = rows.find((row) => row.textContent.includes("Wait for quota reset"));
    const temporal = rows.find((row) => row.classList.contains("qg-temporal-settings__row"));
    return {
      name: root.dataset.harnessCopy,
      wait: wait ? measure(wait) : null,
      temporal: temporal ? measure(temporal) : null,
    };
  };
  document.getElementById("layout-result").textContent = JSON.stringify({
    innerWidth,
    copies: [...document.querySelectorAll("[data-harness-copy]")].map(read),
  });
})();
</script>
</body>
</html>`;
}

function runLayoutProbe(html: string): LayoutProbe {
  if (layoutBrowser === undefined) throw new Error("no local Chromium is available");
  const scratch = mkdtempSync(path.join(os.tmpdir(), "qg-settings-layout-"));
  const page = path.join(scratch, "layout.html");
  const profile = path.join(scratch, "profile");
  writeFileSync(page, html, "utf8");
  try {
    const dom = execFileSync(
      layoutBrowser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        `--user-data-dir=${profile}`,
        "--window-size=600,900",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      { encoding: "utf8", timeout: 45_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    const captured = /<pre id="layout-result">([\s\S]*?)<\/pre>/.exec(dom);
    if (captured?.[1] === undefined || captured[1] === "") {
      throw new Error(`layout probe produced no result; output tail: ${dom.slice(-2000)}`);
    }
    return JSON.parse(captured[1]) as LayoutProbe;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe.skipIf(layoutBrowser === undefined)("Settings row rendered layout", () => {
  it("keeps the control right in a wide row and stacks it in a narrow row", () => {
    const html = renderSettings(
      settingsSnapshot({ import: { available: false, issues: [] } }),
      layoutTemporal(),
    );
    const probe = runLayoutProbe(layoutHarness(html));
    const wide = probe.copies.find((copy) => copy.name === "wide");
    const narrow = probe.copies.find((copy) => copy.name === "narrow");

    /** A missing row means the harness or the Settings markup regressed. */
    const measured = (copy: MeasuredCopy | undefined, key: "wait" | "temporal"): MeasuredRow => {
      const row = copy?.[key];
      if (row === null || row === undefined) {
        throw new Error(`layout probe did not measure the ${key} row`);
      }
      return row;
    };
    const wideWait = measured(wide, "wait");
    const wideTemporal = measured(wide, "temporal");
    const narrowWait = measured(narrow, "wait");
    const narrowTemporal = measured(narrow, "temporal");

    // The window is narrow enough for the old media rule; only the group's own
    // width differs between the two copies.
    expect(probe.innerWidth).toBeLessThan(720);

    expect(wideWait.rowWidth).toBeGreaterThan(540);
    expect(wideWait.grid.trim().split(/\s+/)).toHaveLength(2);
    expect(wideWait.sameLine).toBe(true);
    expect(wideWait.controlLeft).toBeGreaterThan(wideWait.textRight);
    expect(wideWait.controlWidth).toBeGreaterThanOrEqual(220);
    expect(wideWait.controlWidth).toBeLessThanOrEqual(320);
    expect(Math.abs(wideWait.trailingRightGap)).toBeLessThanOrEqual(1);
    expect(wideTemporal.hasSummary).toBe(false);
    expect(wideTemporal.controlLeft).toBeGreaterThan(wideTemporal.textRight);
    expect(Math.abs(wideTemporal.trailingRightGap)).toBeLessThanOrEqual(1);

    expect(narrowWait.rowWidth).toBeLessThan(540);
    expect(narrowWait.grid.trim().split(/\s+/)).toHaveLength(1);
    expect(narrowWait.stacked).toBe(true);
    expect(narrowWait.controlLeftGap).toBeLessThanOrEqual(1);
    expect(Math.abs(narrowWait.controlWidth - narrowWait.rowWidth)).toBeLessThanOrEqual(1);
    expect(narrowWait.trailingRightGap).toBeGreaterThan(narrowWait.rowWidth / 2);
    expect(narrowTemporal.stacked).toBe(true);
    expect(narrowTemporal.controlLeftGap).toBeLessThanOrEqual(1);
    expect(Math.abs(narrowTemporal.controlWidth - narrowTemporal.rowWidth)).toBeLessThanOrEqual(1);
    expect(narrowTemporal.trailingRightGap).toBeGreaterThan(narrowTemporal.rowWidth / 2);
  }, 60_000);
});
