import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DASHBOARD_CONTRACT_VERSION, type DashboardHealth } from "../src/contracts/dashboard";
import type { DashboardClient } from "../src/ui/dashboard-client";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import type { TestNode } from "./fixtures/gui-test-renderer.js";
import {
  homeSnapshot,
  projectSnapshot,
  sessionSnapshot,
  settingsSnapshot,
} from "./fixtures/gui-ui-fixtures.js";

/**
 * Build identity in the shell (design spec §7, §10).
 *
 * The build runner stamps one literal into both the packed backend and the
 * browser bundle. The shell compares the health response with that bundle
 * identity for a restart hint, while the Settings About section reads the very
 * same exported values. These tests mount the shipped `App` through the
 * project's universal render path, so they observe the real health lifecycle:
 * a matching server is quiet, a differing or old server warns, and a contract
 * mismatch remains the stronger gate without hiding compatible Quota for a
 * build-only difference.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPath = fileURLToPath(new URL("./fixtures/gui-test-renderer.ts", import.meta.url));
const solidWebShimPath = fileURLToPath(new URL("./fixtures/gui-solid-web.ts", import.meta.url));

/** The build-time value Vite substitutes in both the product build and this rig. */
const BROWSER_IDENTITY = { version: "1.0.0", build: "a1b2c3d4e5f6-dirty" } as const;
const MISMATCH = "Build mismatch · restart OpenCode";

interface RenderGraph {
  app: (props: { client: DashboardClient }) => TestNode;
  identity: () => { version: string; build: string };
  createTestRoot: () => TestNode;
  mount: (code: () => TestNode, root: TestNode) => () => void;
  textOf: (node: TestNode) => string;
  elementsNamed: (node: TestNode, tag: string) => TestNode[];
}

let server: ViteDevServer | undefined;
let graph: RenderGraph;

beforeAll(async () => {
  const created = await createServer({
    configFile: false,
    root: repoRoot,
    plugins: [
      // The public tooltip imports Kobalte's client-only portal at module load.
      // These tests never assert tooltip content, so the boundary keeps the
      // shipped app graph loadable without a DOM.
      {
        name: "tooltip-render-boundary",
        enforce: "pre",
        transform(_code, id) {
          if (id.replaceAll("\\", "/").endsWith("/overlays/tooltip/tooltip.tsx"))
            return "export function Tooltip(props) { return props.children }";
        },
      },
      solid({
        include: [...SOLID_JSX_SOURCES],
        // `universal` writes the tree through the fixture renderer rather than the
        // DOM; the components themselves are the shipped ones.
        solid: { generate: "universal", moduleName: "@gui-test-renderer" },
      }),
    ],
    define: { __OPENCODE_QUOTA_BUILD_IDENTITY__: JSON.stringify(BROWSER_IDENTITY) },
    resolve: {
      alias: [
        { find: "@gui-test-renderer", replacement: rendererPath },
        // The client build of the reactive core. Under the node condition the
        // signals would be the server's inert ones and the shell would not update.
        {
          find: /^solid-js$/,
          replacement: path.join(repoRoot, "node_modules", "solid-js", "dist", "solid.js"),
        },
        // Kobalte's `Dynamic` needs a DOM-free body on this rig; the shim keeps
        // the real controls while the output stays plain objects.
        { find: /^solid-js\/web$/, replacement: solidWebShimPath },
        {
          find: /^solid-js\/store$/,
          replacement: path.join(repoRoot, "node_modules", "solid-js", "store", "dist", "store.js"),
        },
      ],
    },
    // The settings controls pull Kobalte and its Solid helpers through
    // `@opencode/ui`; they have to run on the same client runtime as the shell.
    ssr: {
      noExternal: [
        "solid-js",
        "solid-js/universal",
        "@opencode/ui",
        "@kobalte/core",
        "@kobalte/utils",
        "@kitlangton/solid-motion",
        "@solid-primitives/props",
        "@solid-primitives/resize-observer",
      ],
    },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  server = created;

  const renderCore = await created.ssrLoadModule("solid-js");
  const renderer = await created.ssrLoadModule(rendererPath);
  const appModule = await created.ssrLoadModule(path.join(repoRoot, "src/ui/app.tsx"));
  const identityModule = await created.ssrLoadModule(
    path.join(repoRoot, "src/contracts/build-identity.ts"),
  );

  graph = {
    app: (props) => renderCore.createComponent(appModule.App, props),
    identity: () => identityModule.BUILD_IDENTITY,
    createTestRoot: renderer.createTestRoot,
    mount: renderer.mountTestTree,
    textOf: renderer.textOf,
    elementsNamed: renderer.elementsNamed,
  } satisfies RenderGraph;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

/** Browser surface only as wide as the shell actually reads. */
function browserStub(initialPath = "/quota") {
  let location = new URL(initialPath, "http://localhost:4144");
  const listeners = new Map<string, (event?: unknown) => void>();
  return {
    get location() {
      return location;
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    history: {
      replaceState: (_state: unknown, _title: string, path: string) => {
        location = new URL(path, location);
      },
      pushState: (_state: unknown, _title: string, path: string) => {
        location = new URL(path, location);
      },
    },
    addEventListener: (name: string, listener: (event?: unknown) => void) => {
      listeners.set(name, listener);
    },
    removeEventListener: (name: string) => {
      listeners.delete(name);
    },
  };
}

function makeClient(health: DashboardClient["health"]): DashboardClient {
  return {
    connection: () => "live",
    onConnectionChange: () => () => {},
    subscribe: () => () => {},
    health,
    quota: async () => homeSnapshot(),
    home: async () => homeSnapshot(),
    project: async () => projectSnapshot(),
    session: async () => sessionSnapshot(),
    settings: async () => settingsSnapshot(),
    saveSettings: async () => ({ revision: "r", applied: {}, warnings: [] }),
    saveVisibility: async () => ({ revision: "r", applied: {}, warnings: [] }),
    importPreview: async () => ({
      from: "workspace: synthetic",
      keys: [],
      issues: [],
      expectedRevision: "r",
    }),
    importApply: async () => ({ revision: "r", applied: {}, warnings: [] }),
  };
}

function mountApp(health: DashboardClient["health"], initialPath = "/quota") {
  vi.stubGlobal("window", browserStub(initialPath));
  const root = graph.createTestRoot();
  const stop = graph.mount(() => graph.app({ client: makeClient(health) }), root);
  return {
    root,
    text: () => graph.textOf(root),
    dispose: () => {
      stop();
      vi.unstubAllGlobals();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function matchingHealth(): DashboardHealth {
  return {
    app: "opencode-quota-gui",
    contractVersion: DASHBOARD_CONTRACT_VERSION,
    ...BROWSER_IDENTITY,
  };
}

function statusNodes(root: TestNode): TestNode[] {
  return graph.elementsNamed(root, "output").filter((node) => node.props.class === "qg-badge");
}

describe("build mismatch status", () => {
  it("reads the same build-time identity the bundle was stamped with", () => {
    expect(graph.identity()).toEqual(BROWSER_IDENTITY);
  });

  it("stays quiet when the running server has the same build", async () => {
    const app = mountApp(async () => matchingHealth());
    try {
      await settle();
      expect(statusNodes(app.root)).toHaveLength(0);
      expect(app.text()).toContain("Five hour window");
    } finally {
      app.dispose();
    }
  });

  it("shows the exact restart hint for a different build without hiding Quota", async () => {
    const app = mountApp(async () => ({ ...matchingHealth(), build: "9999999" }));
    try {
      await settle();
      const status = statusNodes(app.root);
      expect(status).toHaveLength(1);
      expect(graph.textOf(status[0] as TestNode)).toBe(MISMATCH);
      expect(status[0]?.props.title).toContain("Restart OpenCode");
      expect(app.text()).toContain("Five hour window");
    } finally {
      app.dispose();
    }
  });

  it("shows the hint when an older server has no version or build metadata", async () => {
    const app = mountApp(async () => ({
      app: "opencode-quota-gui",
      contractVersion: DASHBOARD_CONTRACT_VERSION,
    }));
    try {
      await settle();
      const status = statusNodes(app.root);
      expect(status).toHaveLength(1);
      expect(graph.textOf(status[0] as TestNode)).toBe(MISMATCH);
      expect(app.text()).toContain("Five hour window");
    } finally {
      app.dispose();
    }
  });

  it("waits for health before warning instead of guessing on first paint", async () => {
    let resolveHealth!: (health: DashboardHealth) => void;
    const health = new Promise<DashboardHealth>((resolve) => {
      resolveHealth = resolve;
    });
    const app = mountApp(() => health);
    try {
      await settle();
      expect(statusNodes(app.root)).toHaveLength(0);
      // Quota does not wait on the diagnostic read.
      expect(app.text()).toContain("Five hour window");

      resolveHealth({ ...matchingHealth(), build: "9999999" });
      await settle();
      expect(statusNodes(app.root)).toHaveLength(1);
    } finally {
      app.dispose();
    }
  });

  it("keeps a contract mismatch stronger and does not add the build warning", async () => {
    const app = mountApp(async () => ({
      app: "opencode-quota-gui",
      contractVersion: DASHBOARD_CONTRACT_VERSION - 1,
      ...BROWSER_IDENTITY,
      build: "9999999",
    }));
    try {
      await settle();
      const body = app.text();
      expect(body).toContain("Restart the dashboard/OpenCode");
      expect(body).not.toContain(MISMATCH);
      expect(body).not.toContain("Five hour window");
    } finally {
      app.dispose();
    }
  });
});

describe("About section", () => {
  it("renders the exported version, build and contract at the bottom of Settings", async () => {
    const app = mountApp(async () => matchingHealth(), "/settings");
    try {
      await settle();
      const scroll = graph
        .elementsNamed(app.root, "div")
        .find((node) => node.props.class === "qg-form qg-settings__scroll");
      expect(scroll).toBeDefined();
      if (!scroll) throw new Error("probe: the Settings scroll container is missing");

      const sections = graph.elementsNamed(scroll, "section");
      const about = sections.find((node) => node.props["aria-labelledby"] === "qg-settings-about");
      expect(about).toBeDefined();
      expect(sections.at(-1)).toBe(about);
      if (!about) throw new Error("probe: the About section is missing");

      const identity = graph.identity();
      const aboutText = graph.textOf(about).replace(/\s+/g, " ").trim();
      expect(aboutText).toContain("About OpenCode Quota GUI");
      expect(aboutText).toContain(
        `Version ${identity.version} · Build ${identity.build} · Contract ${DASHBOARD_CONTRACT_VERSION}`,
      );
      // Restrained: no action, image, or decorative card inside the section.
      expect(graph.elementsNamed(about, "button")).toHaveLength(0);
      expect(graph.elementsNamed(about, "img")).toHaveLength(0);
    } finally {
      app.dispose();
    }
  });
});
