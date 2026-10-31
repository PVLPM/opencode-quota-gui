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
 * Real-browser disclosure interaction (click / pin / viewport).
 *
 * The SSR suites can only prove what one server render emits: a trigger and a
 * closed dialog. They cannot prove that hovering previews, that an unpinned
 * preview survives the pointer entering the panel, that a click pins it so the
 * pointer can leave, that a second click, an outside pointerdown or Escape
 * closes it, that opening another provider's disclosure closes the pinned one,
 * that a tall panel scrolls inside itself without moving the page, or that
 * placement keeps the panel inside the viewport. This harness mounts the real
 * component in Chromium and drives those events.
 *
 * A local Chromium is required; CI without one skips instead of pretending the
 * SSR assertions covered the interaction.
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

/** The harness waits on its own state; Chrome only has to allow the chain to finish. */
const HARNESS_SCRIPT = `
import { render } from "solid-js/web";
import { InteractivePopover } from "__COMPONENT__";

const host = document.getElementById("host");
if (host === null) throw new Error("harness host missing");

render(
  () => (
    <>
      <button id="outside" type="button">outside</button>
      <InteractivePopover
        label="Temporal details"
        placement="bottom-end"
        triggerClass="probe-trigger"
        contentClass="qg-temporal-popover"
        content={
          <div
            data-probe="first"
            style="width:300px;height:900px;background:#fff"
          >
            Panel content
          </div>
        }
      >
        <span>i</span>
      </InteractivePopover>
      <InteractivePopover
        label="Other details"
        placement="bottom-end"
        triggerClass="probe-trigger"
        contentClass="qg-temporal-popover"
        content={
          <div
            data-probe="second"
            style="width:300px;height:80px;background:#fff"
          >
            Other content
          </div>
        }
      >
        <span>ii</span>
      </InteractivePopover>
    </>
  ),
  host,
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
window.addEventListener("error", (event) => failures.push("error: " + event.message));
window.addEventListener("unhandledrejection", (event) =>
  failures.push("rejection: " + (event.reason?.message ?? String(event.reason))),
);
const triggerFor = (label) => document.querySelector('button[aria-label="' + label + '"]');
const dialogFor = (probe) => {
  const content = document.querySelector('[data-probe="' + probe + '"]');
  const element = content?.closest('[role="dialog"]') ?? null;
  if (element === null) return null;
  if (element.hasAttribute("hidden") || element.hasAttribute("data-closed")) return null;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return element;
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

function hover(label) {
  const element = triggerFor(label);
  if (element === null) return;
  element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 1 }));
  element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerId: 1 }));
}

function leave(element) {
  if (element === null) return;
  element.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerId: 1 }));
  element.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerId: 1 }));
}

async function press(label) {
  const element = triggerFor(label);
  if (element === null) return;
  // A real pointer click focuses the button; reproduce that so the disclosure's
  // focus handoff between panels is part of the rendered contract.
  element.focus({ preventScroll: true });
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
  element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(30);
}

async function openByHover(label, probe) {
  return waitFor(() => {
    hover(label);
    return dialogFor(probe);
  }, "hover open " + probe);
}

async function run() {
  const results = {};
  try {
    await waitFor(() => triggerFor("Temporal details"), "trigger");
    const outside = document.getElementById("outside");
    const FIRST = "Temporal details";
    const SECOND = "Other details";

    // An unpinned hover preview survives the pointer moving from the trigger
    // into the panel; only leaving the panel lets the preview lapse.
    await openByHover(FIRST, "first");
    results.hoverOpened = dialogFor("first") !== null;
    results.expandedAfterHover = triggerFor(FIRST)?.getAttribute("aria-expanded");
    const firstContent = document
      .querySelector('[data-probe="first"]')
      ?.closest(".qg-interactive-popover__content");
    leave(triggerFor(FIRST));
    firstContent?.dispatchEvent(
      new PointerEvent("pointerenter", { bubbles: false, pointerId: 1 }),
    );
    await sleep(400);
    results.openAfterPointerTransfer = dialogFor("first") !== null;
    results.expandedAfterPointerTransfer = triggerFor(FIRST)?.getAttribute("aria-expanded");
    leave(firstContent);
    await sleep(400);
    results.closedAfterTransferLeave = dialogFor("first") === null;

    // A click pins the preview; leaving the trigger then keeps it open.
    await openByHover(FIRST, "first");
    await press(FIRST);
    results.clickKeptOpen = dialogFor("first") !== null;
    results.expandedAfterClick = triggerFor(FIRST)?.getAttribute("aria-expanded");
    leave(triggerFor(FIRST));
    await sleep(400);
    results.pinnedAfterLeave = dialogFor("first") !== null;
    results.expandedAfterLeave = triggerFor(FIRST)?.getAttribute("aria-expanded");

    // A second click on the pinned trigger closes it again.
    await press(FIRST);
    await sleep(900);
    results.closedAfterSecondClick = dialogFor("first") === null;
    results.expandedAfterSecondClick = triggerFor(FIRST)?.getAttribute("aria-expanded");

    // An outside pointerdown dismisses the pinned panel.
    await openByHover(FIRST, "first");
    await press(FIRST);
    outside?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    outside?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    outside?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(300);
    results.closedByOutsideClick = dialogFor("first") === null;
    results.expandedAfterOutsideClick = triggerFor(FIRST)?.getAttribute("aria-expanded");

    // Opening another provider's disclosure closes the pinned one first.
    await openByHover(FIRST, "first");
    await press(FIRST);
    await waitFor(() => dialogFor("first"), "first pinned");
    await openByHover(SECOND, "second");
    await sleep(250);
    results.firstClosedOnSwitch = dialogFor("first") === null;
    results.secondOpenedOnSwitch = dialogFor("second") !== null;
    results.expandedFirstAfterSwitch = triggerFor(FIRST)?.getAttribute("aria-expanded");
    results.expandedSecondAfterSwitch = triggerFor(SECOND)?.getAttribute("aria-expanded");

    await press(SECOND);
    leave(triggerFor(SECOND));
    await sleep(400);
    results.secondPinnedAfterSwitch = dialogFor("second") !== null;
    await press(SECOND);
    await sleep(300);
    results.closedAfterSecondPress = dialogFor("second") === null;

    // Escape closes a pinned panel.
    await openByHover(FIRST, "first");
    await press(FIRST);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
    results.closedByEscape = dialogFor("first") === null;
    results.expandedAfterEscape = triggerFor(FIRST)?.getAttribute("aria-expanded");

    // Placement stays inside the viewport in the bottom-right corner.
    await openByHover(FIRST, "first");
    await press(FIRST);
    const element = await waitFor(() => {
      const candidate = dialogFor("first");
      if (candidate === null) return undefined;
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 ? candidate : undefined;
    }, "positioned dialog");
    await sleep(200);
    const rect = element.getBoundingClientRect();
    results.viewport = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      width: innerWidth,
      height: innerHeight,
    };
    results.inViewport =
      rect.left >= -0.5 &&
      rect.top >= -0.5 &&
      rect.right <= innerWidth + 0.5 &&
      rect.bottom <= innerHeight + 0.5;

    // The tall panel scrolls on its own while the surrounding scroller stays
    // where the reader left it (the app shell owns page scrolling, not body).
    const pageScroller = document.getElementById("page-scroller");
    results.pageScrollable =
      pageScroller !== null && pageScroller.scrollHeight > pageScroller.clientHeight;
    if (pageScroller !== null) pageScroller.scrollTop = 300;
    const scroller = dialogFor("first");
    const scrollStyle = scroller === null ? null : getComputedStyle(scroller);
    results.panelOverflowY = scrollStyle?.overflowY ?? null;
    results.panelOverscroll = scrollStyle?.overscrollBehaviorY ?? null;
    results.panelScrollable =
      scroller !== null && scroller.scrollHeight > scroller.clientHeight;
    if (scroller !== null) {
      scroller.scrollTop = 200;
      results.panelScrollTop = scroller.scrollTop;
    }
    results.pageScrollTop = pageScroller?.scrollTop ?? -1;
    results.pageScrollY = window.scrollY;
  } catch (error) {
    results.error = error instanceof Error ? error.message : String(error);
    results.debug = {
      failures,
      triggers: [...document.querySelectorAll('button[aria-haspopup="dialog"]')].map((entry) =>
        entry.outerHTML.slice(0, 300),
      ),
      content: document.querySelector('[data-component="popover-content"]') !== null,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      readyState: document.readyState,
    };
  }
  const output = document.getElementById("result");
  if (output !== null) output.textContent = JSON.stringify(results);
}

void run();
`;

interface InteractionResult {
  error?: string;
  debug?: unknown;
  hoverOpened?: boolean;
  openAfterPointerTransfer?: boolean;
  closedAfterTransferLeave?: boolean;
  clickKeptOpen?: boolean;
  pinnedAfterLeave?: boolean;
  closedAfterSecondClick?: boolean;
  closedByOutsideClick?: boolean;
  firstClosedOnSwitch?: boolean;
  secondOpenedOnSwitch?: boolean;
  secondPinnedAfterSwitch?: boolean;
  closedAfterSecondPress?: boolean;
  closedByEscape?: boolean;
  inViewport?: boolean;
  panelScrollable?: boolean;
  panelScrollTop?: number;
  pageScrollable?: boolean;
  pageScrollY?: number;
  pageScrollTop?: number;
  panelOverflowY?: string | null;
  panelOverscroll?: string | null;
  expandedAfterHover?: string | null;
  expandedAfterPointerTransfer?: string | null;
  expandedAfterClick?: string | null;
  expandedAfterLeave?: string | null;
  expandedAfterSecondClick?: string | null;
  expandedAfterOutsideClick?: string | null;
  expandedFirstAfterSwitch?: string | null;
  expandedSecondAfterSwitch?: string | null;
  expandedAfterEscape?: string | null;
  viewport?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
}

let scratch: string | undefined;

beforeAll(() => {
  if (browser === undefined) return;
  scratch = mkdtempSync(path.join(os.tmpdir(), "qg-popover-interaction-"));
}, 60_000);

afterAll(() => {
  if (scratch === undefined) return;
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function buildHarness(directory: string): Promise<void> {
  const componentPath = path
    .join(repoRoot, "src/ui/components/interactive-popover.tsx")
    .replaceAll("\\", "/");
  const entryPath = path.join(directory, "entry.tsx");
  writeFileSync(entryPath, HARNESS_SCRIPT.replace("__COMPONENT__", componentPath), "utf8");

  // The harness lives outside the repo, so pin the browser entry points instead
  // of letting Node resolve the server builds from the temp directory.
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

function runHarness(directory: string): InteractionResult {
  if (browser === undefined) throw new Error("no local Chromium is available");
  const page = path.join(directory, "page.html");
  // Inline both assets: the probe drives timers under Chrome's virtual clock,
  // and a linked 1.6 MB stylesheet can consume the navigation budget before the
  // harness's own async chain finishes.
  const css = readFileSync(path.join(directory, "out/harness.css"), "utf8");
  // The panel scroll contract lives in the dashboard stylesheet, so inline it
  // too instead of asserting on an unstyled harness element.
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
<title>popover interaction probe</title>
<style>${css}</style>
<style>${appCss}</style>
<style>body{margin:0;font:14px system-ui,sans-serif}#host{position:fixed;right:8px;bottom:8px}#outside{position:fixed;left:8px;top:8px}</style>
</head>
<body>
<div id="page-scroller" style="height:220px;overflow-y:auto"><div style="height:2400px"></div></div>
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
      "--window-size=640,420",
      "--virtual-time-budget=15000",
      "--dump-dom",
      pathToFileURL(page).href,
    ],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  const captured = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom);
  if (captured?.[1] === undefined || captured[1] === "pending") {
    throw new Error(`interaction probe produced no result; output tail: ${dom.slice(-2000)}`);
  }
  return JSON.parse(captured[1]) as InteractionResult;
}

describe.skipIf(browser === undefined)("temporal popover rendered interaction", () => {
  it("transfers hover, pins and dismisses correctly, switches providers, and scrolls internally", async () => {
    if (scratch === undefined) throw new Error("interaction scratch directory is missing");
    await buildHarness(scratch);
    const result = runHarness(scratch);

    expect(result.error, JSON.stringify(result.debug)).toBeUndefined();
    expect(result.hoverOpened).toBe(true);
    expect(result.expandedAfterHover).toBe("true");

    // A hover preview survives the pointer entering the panel before the lease
    // expires, and only lapses once the pointer leaves the panel again.
    expect(result.openAfterPointerTransfer).toBe(true);
    expect(result.expandedAfterPointerTransfer).toBe("true");
    expect(result.closedAfterTransferLeave).toBe(true);

    // A click pins the hover preview instead of closing it, so the pointer can
    // travel into the panel.
    expect(result.clickKeptOpen).toBe(true);
    expect(result.expandedAfterClick).toBe("true");
    expect(result.pinnedAfterLeave).toBe(true);
    expect(result.expandedAfterLeave).toBe("true");

    // The pinned disclosure closes on an explicit second click, an outside
    // pointerdown, and Escape.
    expect(result.closedAfterSecondClick).toBe(true);
    expect(result.expandedAfterSecondClick).toBe("false");
    expect(result.closedByOutsideClick).toBe(true);
    expect(result.expandedAfterOutsideClick).toBe("false");
    expect(result.closedByEscape).toBe(true);
    expect(result.expandedAfterEscape).toBe("false");

    // Opening the other provider's disclosure closes the pinned one, and the
    // newly opened panel can itself be pinned.
    expect(result.firstClosedOnSwitch).toBe(true);
    expect(result.secondOpenedOnSwitch).toBe(true);
    expect(result.expandedFirstAfterSwitch).toBe("false");
    expect(result.expandedSecondAfterSwitch).toBe("true");
    expect(result.secondPinnedAfterSwitch).toBe(true);
    expect(result.closedAfterSecondPress).toBe(true);

    // Placement stays inside the viewport even when the trigger sits in the
    // bottom-right corner and the panel cannot fit below it.
    expect(result.viewport).toBeDefined();
    expect(result.inViewport).toBe(true);
    expect(result.viewport?.left).toBeGreaterThanOrEqual(0);
    expect(result.viewport?.top).toBeGreaterThanOrEqual(0);
    expect(result.viewport?.right).toBeLessThanOrEqual((result.viewport?.width ?? 0) + 0.5);
    expect(result.viewport?.bottom).toBeLessThanOrEqual((result.viewport?.height ?? 0) + 0.5);

    // The tall panel owns its overflow instead of growing or scrolling the page.
    expect(result.panelOverflowY).toBe("auto");
    expect(result.panelOverscroll).toBe("contain");
    expect(result.panelScrollable).toBe(true);
    expect(result.panelScrollTop).toBeGreaterThan(100);
    expect(result.pageScrollable).toBe(true);
    expect(result.pageScrollY).toBe(0);
    expect(result.pageScrollTop).toBe(300);
  }, 120_000);
});
