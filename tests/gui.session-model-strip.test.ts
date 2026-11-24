import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The individual-header model strip fits complete identities and reuses the
 * dashboard's `+N` disclosure. SSR can only show the initial list, so this
 * Chromium probe proves the measured fit and that hover/focus expose the whole
 * ordered list.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = [
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

const IDENTITIES = [
  { providerId: "mistral", modelId: "alpha-one", effort: "max" },
  { providerId: "openai", modelId: "gpt-6.1-terra", effort: "high" },
  { providerId: "anthropic", modelId: "sonnet" },
  { providerId: "mistral", modelId: "alpha-one", effort: "max" },
  { providerId: "openai", modelId: "gpt-6.1-luna" },
];
const SHORT_IDENTITIES = [
  "alpha-one#max",
  "gpt-6.1-terra#high",
  "sonnet",
  "alpha-one#max",
  "gpt-6.1-luna",
];
const FULL_IDENTITIES = [
  "mistral/alpha-one#max",
  "openai/gpt-6.1-terra#high",
  "anthropic/sonnet",
  "mistral/alpha-one#max",
  "openai/gpt-6.1-luna",
];

const HARNESS_SCRIPT = `
import { render } from "solid-js/web";
import { SessionModelStrip } from "__COMPONENT__";

const identities = __IDENTITIES__;
const host = document.getElementById("host");
if (host === null) throw new Error("harness host missing");
render(
  () => (
    <div style="width:260px;font:13px system-ui,sans-serif">
      <SessionModelStrip identities={identities} />
    </div>
  ),
  host,
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
window.addEventListener("error", (event) => failures.push("error: " + event.message));
window.addEventListener("unhandledrejection", (event) =>
  failures.push("rejection: " + (event.reason?.message ?? String(event.reason))),
);
const strip = () => document.querySelector(".qg-page-head__models");
const trigger = () => document.querySelector(".qg-page-head__models .qg-node__more");
const dialog = () => {
  const list = document.querySelector(".qg-node__model-list");
  const element = list?.closest('[role="dialog"]') ?? null;
  if (element === null) return null;
  if (element.hasAttribute("hidden") || element.hasAttribute("data-closed")) return null;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? element : null;
};
async function waitFor(read, label) {
  const start = performance.now();
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    if (performance.now() - start > 5000) throw new Error("timeout: " + label);
    await sleep(25);
  }
}
function hover(element) {
  element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 1 }));
  element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerId: 1 }));
}
function leave(element) {
  element.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerId: 1 }));
  element.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerId: 1 }));
}
const listOf = (panel) =>
  Array.from(panel.querySelectorAll(".qg-node__model-list li")).map((item) =>
    (item.textContent || "").trim(),
  );
const labelsOf = (root) =>
  Array.from(root.querySelectorAll(".qg-model-identity")).map((item) => ({
    text: (item.textContent || "").trim(),
    title: item.getAttribute("title"),
    aria: item.getAttribute("aria-label"),
    logo: item.querySelector(".qg-provider-logo") !== null,
  }));

async function run() {
  const results = {};
  try {
    await waitFor(trigger, "overflow trigger");
    await waitFor(() => {
      const host = strip();
      if (host === null) return null;
      const count = host.querySelectorAll(".qg-page-head__models-entry").length;
      return count > 0 && count < identities.length ? host : null;
    }, "fitted entries");
    const host = strip();
    const bubble = trigger();
    if (host === null || bubble === null) throw new Error("strip is missing after fitting");
    const entries = Array.from(host.querySelectorAll(".qg-page-head__models-entry")).map((item) =>
      (item.textContent || "").trim(),
    );
    results.entries = entries;
    results.entryCount = entries.length;
    results.entryLabels = labelsOf(host).slice(0, entries.length);
    results.overflowText = (bubble.textContent || "").trim();
    results.ariaLabel = bubble.getAttribute("aria-label");
    results.title = host.getAttribute("title");
    results.fits = host.scrollWidth <= host.clientWidth + 1;

    hover(bubble);
    const hovered = await waitFor(() => {
      const button = trigger();
      if (button !== null) hover(button);
      return dialog();
    }, "hover dialog");
    results.hoverList = listOf(hovered);
    results.hoverLabels = labelsOf(hovered);
    const leaving = trigger();
    if (leaving !== null) leave(leaving);
    await sleep(300);
    results.closedAfterLeave = dialog() === null;
    // Closing suppresses an immediate focus-open for 300 ms; wait it out so
    // the keyboard check starts from a fresh disclosure.
    await sleep(450);

    const focused = await waitFor(() => {
      const button = trigger();
      if (button !== null) button.focus({ preventScroll: true });
      return dialog();
    }, "focus dialog");
    results.focusList = listOf(focused);
    results.focusLabels = labelsOf(focused);
    trigger()?.blur();
  } catch (error) {
    failures.push(String(error && error.stack ? error.stack : error));
  }
  results.failures = failures;
  document.getElementById("result").textContent = JSON.stringify(results);
}
void run();
`;

interface ProbeLabel {
  text: string;
  title: string | null;
  aria: string | null;
  logo: boolean;
}

interface ProbeResult {
  entries: string[];
  entryCount: number;
  entryLabels: ProbeLabel[];
  overflowText: string;
  ariaLabel: string | null;
  title: string | null;
  fits: boolean;
  hoverList: string[];
  hoverLabels: ProbeLabel[];
  closedAfterLeave: boolean;
  focusList: string[];
  focusLabels: ProbeLabel[];
  failures: string[];
}

let scratch: string | undefined;

beforeAll(() => {
  if (browser === undefined) return;
  scratch = mkdtempSync(path.join(os.tmpdir(), "qg-session-model-strip-"));
}, 60_000);

afterAll(() => {
  if (scratch === undefined) return;
  rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

async function buildHarness(directory: string): Promise<void> {
  const componentPath = path
    .join(repoRoot, "src/ui/components/session-model-strip.tsx")
    .replaceAll("\\", "/");
  const entryPath = path.join(directory, "entry.tsx");
  writeFileSync(
    entryPath,
    HARNESS_SCRIPT.replace("__COMPONENT__", componentPath).replace(
      "__IDENTITIES__",
      JSON.stringify(IDENTITIES),
    ),
    "utf8",
  );

  const requireFromRepo = createRequire(import.meta.url);
  const solidRoot = path.dirname(requireFromRepo.resolve("solid-js/package.json"));

  await build({
    configFile: false,
    root: directory,
    logLevel: "silent",
    plugins: [
      solid({
        dev: false,
        solid: { dev: false },
        include: [
          /src\/ui\//,
          /@opencode\/ui\//,
          /@kobalte\/core\//,
          /@kitlangton\/solid-motion\//,
          /entry\.tsx$/,
        ],
      }),
    ],
    resolve: {
      alias: [
        { find: /^solid-js$/, replacement: path.join(solidRoot, "dist/solid.js") },
        { find: /^solid-js\/web$/, replacement: path.join(solidRoot, "web/dist/web.js") },
        { find: /^solid-js\/store$/, replacement: path.join(solidRoot, "store/dist/store.js") },
        { find: /^solid-js\/html$/, replacement: path.join(solidRoot, "html/dist/html.js") },
      ],
      dedupe: ["solid-js"],
    },
    esbuild: { jsx: "preserve", jsxImportSource: "solid-js" },
    build: {
      outDir: path.join(directory, "out"),
      emptyOutDir: true,
      minify: false,
      target: "es2022",
      lib: {
        entry: entryPath,
        formats: ["iife"],
        name: "QgHarness",
        fileName: () => "harness.js",
        cssFileName: "harness",
      },
    },
  });
}

function runHarness(directory: string): ProbeResult {
  if (browser === undefined) throw new Error("no local Chromium is available");
  const page = path.join(directory, "page.html");
  const css = readFileSync(path.join(directory, "out/harness.css"), "utf8");
  const appCss = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8").replaceAll(
    "</style",
    "<\\/style",
  );
  const script = readFileSync(path.join(directory, "out/harness.js"), "utf8").replaceAll(
    "</script",
    "<\\/script",
  );
  writeFileSync(
    page,
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>session model strip probe</title>
<style>${css}</style>
<style>${appCss}</style>
<style>body{margin:0;padding:16px}#result{position:fixed;left:-9999px;top:0}</style>
</head>
<body>
<div id="host"></div>
<pre id="result">pending</pre>
<script>${script}</script>
</body>
</html>`,
    "utf8",
  );
  const dom = execFileSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      `--user-data-dir=${path.join(directory, "profile")}`,
      "--window-size=480,320",
      "--virtual-time-budget=15000",
      "--dump-dom",
      pathToFileURL(page).href,
    ],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  const captured = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom);
  if (captured?.[1] === undefined || captured[1] === "pending") {
    throw new Error(`session model probe produced no result; output tail: ${dom.slice(-2000)}`);
  }
  // SAFETY: the harness writes a JSON probe result with the documented shape.
  return JSON.parse(captured[1]) as ProbeResult;
}

describe.skipIf(browser === undefined)("individual-header model strip in Chromium", () => {
  it("fits complete entries, then opens the whole ordered list on hover and focus", async () => {
    // SAFETY: the suite's scratch directory is created as a string path.
    const directory = scratch as string;
    await buildHarness(directory);
    const result = runHarness(directory);

    expect(result.failures).toEqual([]);
    expect(result.entryCount).toBeGreaterThan(0);
    expect(result.entryCount).toBeLessThan(IDENTITIES.length);
    expect(result.entries).toEqual(SHORT_IDENTITIES.slice(0, result.entryCount));
    expect(result.entryLabels.map((label) => label.title)).toEqual(
      FULL_IDENTITIES.slice(0, result.entryCount),
    );
    expect(result.entryLabels.every((label) => label.logo)).toBe(true);
    expect(result.entryLabels.every((label) => label.aria?.includes(label.title ?? ""))).toBe(true);
    expect(result.overflowText).toBe(`+${IDENTITIES.length - result.entryCount}`);
    expect(result.ariaLabel).toBe(
      `${IDENTITIES.length - result.entryCount} more model configurations. Show all ${IDENTITIES.length}.`,
    );
    // The bubble replaces the single-model title, so no native tooltip stacks.
    expect(result.title).toBeNull();
    expect(result.fits).toBe(true);
    expect(result.hoverList).toEqual(SHORT_IDENTITIES);
    expect(result.hoverLabels.map((label) => label.title)).toEqual(FULL_IDENTITIES);
    expect(result.hoverLabels.every((label) => label.logo)).toBe(true);
    expect(result.closedAfterLeave).toBe(true);
    expect(result.focusList).toEqual(SHORT_IDENTITIES);
    expect(result.focusLabels.map((label) => label.title)).toEqual(FULL_IDENTITIES);
  }, 120_000);
});
