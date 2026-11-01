import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = [
  process.env.QG_LAYOUT_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((entry): entry is string => !!entry && existsSync(entry));

describe.skipIf(!browser)("native temporal popover layout in Chromium", () => {
  it("insets header, badge, model and schedule from the popup edges", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qg-native-popover-"));
    try {
      const entry = path.join(dir, "entry.tsx");
      const component = path
        .join(root, "src/ui/components/temporal-status.tsx")
        .replaceAll("\\", "/");
      writeFileSync(
        entry,
        `
import { render } from "solid-js/web";
import { TemporalProviderChip } from ${JSON.stringify(component)};
const now = Date.now();
render(() => <TemporalProviderChip status={{ providerId: "example", providerLabel: "Example Provider", discovered: true, phase: "peak", holidays: [], models: [{ modelId: "example-model", state: "peak", intervals: [{ startMs: now - 3600000, endMs: now + 3600000, phase: "peak" }, { startMs: now + 3600000, endMs: now + 7200000, phase: "offpeak" }] }] }} />, document.getElementById("host"));
setTimeout(() => document.querySelector('button[aria-haspopup="dialog"]').dispatchEvent(new PointerEvent("pointerenter", { bubbles: true })), 100);
setTimeout(() => {
  const panel = document.querySelector('[role="dialog"]');
  const bounds = (element) => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom }; };
  const result = { panel: panel && bounds(panel), elements: {} };
  for (const selector of [".qg-temporal-popover__head", ".qg-temporal-popover__phase", ".qg-temporal-popover__model-id", ".qg-temporal-popover__interval"]) {
    const el = panel?.querySelector(selector);
    result.elements[selector] = el && bounds(el);
  }
  document.getElementById("result").textContent = JSON.stringify(result);
}, 600);
`,
      );
      const requireFromRepo = createRequire(import.meta.url);
      const solidRoot = path.dirname(requireFromRepo.resolve("solid-js/package.json"));
      await build({
        configFile: false,
        root: dir,
        logLevel: "silent",
        plugins: [solid({ include: [/src\/(ui|native)\//, /entry\.tsx$/] })],
        resolve: {
          alias: [
            { find: /^\.\.?\/opencode-ui$/, replacement: path.join(root, "src/native/ui.tsx") },
            {
              find: /^\.\.?\/provider-logo$/,
              replacement: path.join(root, "src/native/provider-logo.tsx"),
            },
            { find: /^solid-js$/, replacement: path.join(solidRoot, "dist/solid.js") },
            { find: /^solid-js\/web$/, replacement: path.join(solidRoot, "web/dist/web.js") },
            { find: /^solid-js\/store$/, replacement: path.join(solidRoot, "store/dist/store.js") },
          ],
          dedupe: ["solid-js"],
        },
        esbuild: { jsx: "preserve", jsxImportSource: "solid-js" },
        build: {
          outDir: path.join(dir, "out"),
          minify: false,
          lib: { entry, formats: ["iife"], name: "Probe", fileName: () => "probe.js" },
        },
      });
      const css = ["src/ui/base.css", "src/ui/styles.css", "src/native/native.css"]
        .map((file) => readFileSync(path.join(root, file), "utf8"))
        .join("\n");
      const script = readFileSync(path.join(dir, "out/probe.js"), "utf8");
      const page = path.join(dir, "page.html");
      writeFileSync(
        page,
        `<!doctype html><style>${css}</style><div class="qg-native" id="host"></div><pre id="result">pending</pre><script>${script}</script>`,
      );
      const dom = execFileSync(
        browser!,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          `--user-data-dir=${path.join(dir, "profile")}`,
          "--window-size=900,700",
          "--virtual-time-budget=3000",
          "--dump-dom",
          pathToFileURL(page).href,
        ],
        { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      const result = JSON.parse(/<pre id="result">([\s\S]*?)<\/pre>/.exec(dom)?.[1] ?? "null") as {
        panel: { left: number; right: number; top: number; bottom: number };
        elements: Record<string, { left: number; right: number; top: number; bottom: number }>;
      };
      expect(result.panel).toBeTruthy();
      for (const element of Object.values(result.elements)) {
        expect(element).toBeTruthy();
        expect(element.left - result.panel.left).toBeGreaterThanOrEqual(12);
        expect(result.panel.right - element.right).toBeGreaterThanOrEqual(12);
        expect(element.top - result.panel.top).toBeGreaterThanOrEqual(12);
        expect(result.panel.bottom - element.bottom).toBeGreaterThanOrEqual(12);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60000);
});
