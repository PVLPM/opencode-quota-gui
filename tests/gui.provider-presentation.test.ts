import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm as removeDirectory, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  archiveContentDigest,
  inspectSvgSafety,
  normalizedSvg,
  removeStaleLogoFiles,
  verifyArchiveContent,
} from "../scripts/sync-provider-logos.mjs";
import type { ProviderCard } from "../src/contracts/dashboard.js";
import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";
import type { DisplayPreferences } from "../src/ui/components/quota-card.js";
import { resolveProviderPresentation } from "../src/ui/provider-catalog.js";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import { NOW, percentRow, providerCard } from "./fixtures/gui-ui-fixtures.js";

/**
 * Provider presentation is a local, browser-safe catalog. It is shared by the
 * Quota cards today and by the model/provider surfaces that follow, so it must
 * resolve historical upstream identities without an active quota integration,
 * keep raw identities exact, and never turn an id into an asset path.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logoDir = path.join(repoRoot, "src/ui/assets/provider-logos");
const runtimeCatalogPath = path.join(repoRoot, "src/ui/provider-logos.generated.json");
const manifestPath = path.join(logoDir, "manifest.json");
const PINNED_REVISION = "30a8b13a5a5507979ddbf8d339c7746cf7e4f442";
const REMOTE_URL = /(?:https?:)?\/\//u;

interface GeneratedLogo {
  label: string;
  url: string;
}

interface GeneratedCatalog {
  source: string;
  revision: string;
  logos: Record<string, GeneratedLogo>;
}

interface IntegrityLogo extends GeneratedLogo {
  label: string;
  url: string;
  bytes: number;
  sha256: string;
}

interface IntegrityManifest {
  source: string;
  repository: string;
  revision: string;
  license: string;
  logoCount: number;
  logoBytes: number;
  upstreamBytes: number;
  logos: Record<string, IntegrityLogo>;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const runtimeCatalog = readJson<GeneratedCatalog>(runtimeCatalogPath);
const manifest = readJson<IntegrityManifest>(manifestPath);
const providerLogoFiles = readdirSync(logoDir)
  .filter((file) => file.endsWith(".svg"))
  .sort();

interface SsrGraph {
  renderToString: (fn: () => unknown) => string;
  createComponent: (component: unknown, props: unknown) => unknown;
  load: (path: string) => Promise<Record<string, unknown>>;
}

let server: ViteDevServer | undefined;
let graph: SsrGraph;

beforeAll(async () => {
  const created = await createServer({
    configFile: false,
    root: path.join(repoRoot, "src/ui"),
    plugins: [
      // The public tooltip imports Kobalte's client-only portal at module load.
      // Quota cards render no tooltip in these assertions, but the module graph
      // still has to load under SSR.
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
}, 60_000);

afterAll(async () => {
  await server?.close();
});

async function renderView(modulePath: string, exportName: string, props: unknown): Promise<string> {
  const module = await graph.load(modulePath);
  const component = module[exportName];
  if (typeof component !== "function")
    throw new Error(`${modulePath} does not export ${exportName}`);
  return graph.renderToString(() => graph.createComponent(component, props));
}

const preferences: DisplayPreferences = {
  percentMode: "remaining",
  percentLabelStyle: "full",
  showRunway: false,
  detailed: false,
};

function quotaCard(overrides: Partial<ProviderCard> = {}): ProviderCard {
  return providerCard({
    cardId: "opencode-go#card" as never,
    providerId: "opencode-go",
    providerLabel: "OpenCode Go",
    planLabel: "Plus",
    accountLabel: "[OpenCode Go] (Work)",
    rows: [
      percentRow({ rowId: "five-hour" as never, label: "Five hour window" }),
      percentRow({
        rowId: "weekly" as never,
        label: "Weekly window",
        percentRemaining: 20,
        percentUsed: 80,
      }),
    ],
    ...overrides,
  });
}

function identityMarkup(html: string): string {
  return html.slice(html.indexOf('<div class="qg-card__identity">'), html.indexOf("</header>"));
}

function plainIdentity(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<[^>]*>/gu, "")
    .trim();
}

describe("provider presentation catalog", () => {
  it("vendors the complete pinned models.dev logo catalog", () => {
    expect(runtimeCatalog.source).toBe("models.dev");
    expect(runtimeCatalog.revision).toBe(PINNED_REVISION);
    expect(manifest.source).toBe("models.dev");
    expect(manifest.revision).toBe(PINNED_REVISION);
    expect(manifest.license).toBe("MIT");
    expect(manifest.logoCount).toBe(222);
    expect(Object.keys(runtimeCatalog.logos)).toHaveLength(222);
    expect(Object.keys(manifest.logos)).toHaveLength(222);
    expect(manifest.upstreamBytes).toBe(623_957);
    expect(manifest.logoBytes).toBeGreaterThan(600_000);
    expect(manifest.logoBytes).toBeLessThan(650_000);
    expect(providerLogoFiles).toHaveLength(223);
    expect(providerLogoFiles).toContain("generic.svg");

    for (const [id, entry] of Object.entries(runtimeCatalog.logos)) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9.-]*$/u);
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.url).toBe(`/assets/providers/${id}.svg`);
      const file = path.join(logoDir, `${id}.svg`);
      expect(existsSync(file), `missing ${file}`).toBe(true);
      const bytes = readFileSync(file);
      expect(statSync(file).size).toBe(manifest.logos[id]?.bytes);
      expect(sha256(bytes)).toBe(manifest.logos[id]?.sha256);
      expect(() => inspectSvgSafety(bytes.toString("utf8"), file)).not.toThrow();
    }

    const verified = execFileSync(
      process.execPath,
      ["scripts/sync-provider-logos.mjs", "--check"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(verified).toContain("Provider logos verified");
  });

  it("keeps OpenCode and OpenCode Go distinct identities with the same upstream artwork", () => {
    const opencode = resolveProviderPresentation("opencode");
    const opencodeGo = resolveProviderPresentation("opencode-go");
    const opencodeZen = resolveProviderPresentation("opencode-zen");

    expect(opencode.providerId).toBe("opencode");
    expect(opencodeGo.providerId).toBe("opencode-go");
    expect(opencodeZen.providerId).toBe("opencode-zen");
    expect(opencode.label).toBe("OpenCode Zen");
    expect(opencodeGo.label).toBe("OpenCode Go");
    expect(opencodeZen.label).toBe("OpenCode Zen");
    expect(opencode.hasSpecificLogo).toBe(true);
    expect(opencodeGo.hasSpecificLogo).toBe(true);
    expect(opencode.logoSrc).toBe("/assets/providers/opencode.svg");
    expect(opencodeGo.logoSrc).toBe("/assets/providers/opencode-go.svg");
    expect(opencodeZen.logoSrc).toBe(opencode.logoSrc);

    const opencodeHash = sha256(readFileSync(path.join(logoDir, "opencode.svg")));
    const opencodeGoHash = sha256(readFileSync(path.join(logoDir, "opencode-go.svg")));
    expect(opencodeGoHash).toBe(opencodeHash);
  });

  it.each([
    ["copilot", "Copilot", "/assets/providers/github-copilot.svg"],
    ["claude", "Anthropic", "/assets/providers/anthropic.svg"],
    ["google-gemini-cli", "Gemini CLI", "/assets/providers/google.svg"],
    ["google-agy", "Google AGY", "/assets/providers/google.svg"],
    ["nanogpt", "NanoGPT", "/assets/providers/nano-gpt.svg"],
    ["kimi", "Kimi Code (CN)", "/assets/providers/kimi-code-plan-cn.svg"],
    ["glm", "Z.ai", "/assets/providers/zai.svg"],
    ["zhipu", "Zhipu", "/assets/providers/zhipuai.svg"],
    ["opencode-go-subscription", "OpenCode Go", "/assets/providers/opencode-go.svg"],
  ])("resolves the explicit internal alias %s", (rawId, label, logoSrc) => {
    const presentation = resolveProviderPresentation(rawId);
    expect(presentation.providerId).toBe(rawId);
    expect(presentation.label).toBe(label);
    expect(presentation.logoSrc).toBe(logoSrc);
    expect(presentation.logoKey).toBe(logoSrc.slice("/assets/providers/".length, -".svg".length));
    expect(presentation.hasSpecificLogo).toBe(true);
  });

  it("resolves the canonical zhipu registration id through the zhipuai mark", () => {
    expect(QUOTA_PROVIDER_REGISTRATION_SOURCE.some((provider) => provider.id === "zhipu")).toBe(
      true,
    );

    const canonical = resolveProviderPresentation("zhipu");
    expect(canonical.providerId).toBe("zhipu");
    expect(canonical.label).toBe("Zhipu");
    expect(canonical.logoKey).toBe("zhipuai");
    expect(canonical.logoSrc).toBe("/assets/providers/zhipuai.svg");
    expect(canonical.hasSpecificLogo).toBe(true);

    const upstream = resolveProviderPresentation("zhipuai");
    expect(upstream.providerId).toBe("zhipuai");
    expect(upstream.label).toBe("Zhipu");
    expect(upstream.logoSrc).toBe("/assets/providers/zhipuai.svg");
    expect(upstream.hasSpecificLogo).toBe(true);
  });

  it("treats Object prototype names as unknown ids, not inherited catalog entries", () => {
    for (const rawId of [
      "constructor",
      "__proto__",
      "prototype",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      const presentation = resolveProviderPresentation(rawId);
      expect(presentation.providerId).toBe(rawId);
      expect(typeof presentation.label).toBe("string");
      expect(presentation.label).toBe(rawId);
      expect(presentation.logoKey).toBe("generic");
      expect(presentation.logoSrc).toBe("/assets/providers/generic.svg");
      expect(presentation.hasSpecificLogo).toBe(false);
    }
  });

  it("keeps disconnected upstream providers and local fallbacks independent of integrations", () => {
    const upstreamOnly = resolveProviderPresentation("302ai");
    expect(upstreamOnly.providerId).toBe("302ai");
    expect(upstreamOnly.label).toBe("302.AI");
    expect(upstreamOnly.logoSrc).toBe("/assets/providers/302ai.svg");
    expect(upstreamOnly.hasSpecificLogo).toBe(true);
    expect(QUOTA_PROVIDER_REGISTRATION_SOURCE.some((provider) => provider.id === "302ai")).toBe(
      false,
    );

    const synthetic = resolveProviderPresentation("synthetic");
    expect(synthetic.providerId).toBe("synthetic");
    expect(synthetic.label).toBe("Synthetic");
    expect(synthetic.logoSrc).toBe("/assets/providers/generic.svg");
    expect(synthetic.hasSpecificLogo).toBe(false);
  });

  it("covers every internal canonical, runtime, synonym and label id", () => {
    for (const registration of QUOTA_PROVIDER_REGISTRATION_SOURCE) {
      const ids = [
        registration.id,
        ...registration.runtimeIds,
        ...registration.synonyms,
        ...(registration.labelAliases ?? []),
      ];
      for (const rawId of ids) {
        const presentation = resolveProviderPresentation(rawId);
        expect(presentation.providerId, rawId).toBe(rawId);
        expect(presentation.label.trim().length, rawId).toBeGreaterThan(0);
        expect(presentation.logoSrc).toMatch(/^\/assets\/providers\/[a-z0-9][a-z0-9.-]*\.svg$/u);
      }
    }
  });

  it("uses the generic fallback for upstream marks that lose their silhouette in a monochrome mask", () => {
    for (const id of ["atomic-chat", "orcarouter", "zenmux"]) {
      const presentation = resolveProviderPresentation(id);
      expect(presentation.label).toBe(runtimeCatalog.logos[id]?.label);
      expect(presentation.logoSrc).toBe("/assets/providers/generic.svg");
      expect(presentation.hasSpecificLogo).toBe(false);
    }
  });

  it("uses the generic fallback for unknown, empty and asset-like ids without interpolation", () => {
    const cases: Array<[string, string]> = [
      ["not-a-provider", "not-a-provider"],
      ["unknown", "unknown"],
      ["", "Unknown provider"],
      ["   ", "Unknown provider"],
      ["../../etc/passwd", "../../etc/passwd"],
      ["openai/../../secret", "openai/../../secret"],
      ["openai.svg", "openai.svg"],
    ];
    for (const [rawId, label] of cases) {
      const presentation = resolveProviderPresentation(rawId);
      expect(presentation.providerId).toBe(rawId);
      expect(presentation.label).toBe(label);
      expect(presentation.logoKey).toBe("generic");
      expect(presentation.logoSrc).toBe("/assets/providers/generic.svg");
      expect(presentation.hasSpecificLogo).toBe(false);
      if (rawId.length > 0) expect(presentation.logoSrc).not.toContain(rawId);
      expect(presentation.logoSrc).not.toContain("..");
    }
  });

  it("never references a remote logo or injects SVG markup", () => {
    expect(JSON.stringify(runtimeCatalog)).not.toMatch(REMOTE_URL);
    for (const entry of Object.values(runtimeCatalog.logos)) {
      expect(entry.url.startsWith("/assets/providers/")).toBe(true);
      expect(entry.url.startsWith("//")).toBe(false);
      expect(entry.url).not.toMatch(REMOTE_URL);
    }
    for (const file of providerLogoFiles) {
      const svg = readFileSync(path.join(logoDir, file), "utf8");
      expect(() => inspectSvgSafety(svg, file)).not.toThrow();
    }
  });
});

describe("SVG safety validation", () => {
  it.each([
    [
      "CSS-escaped url function",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\72l(https\\3a//evil.example/x.svg#id)"/></svg>',
    ],
    [
      "CSS hex-escaped url function and scheme",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\000072l(\\68ttps\\3a\\2f\\2fevil.example/x.svg)"/></svg>',
    ],
    [
      "CSS comment splitting the url token",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u/**/rl(https://evil.example/x.svg)"/></svg>',
    ],
    [
      "CSS-escaped scheme inside url",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(https\\3a//evil.example/x.svg)"/></svg>',
    ],
    [
      "CSS-escaped protocol-relative url",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(\\2f\\2fevil.example/x.svg)"/></svg>',
    ],
    [
      "XML-entity-hidden url token",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:&#x75;rl(https://evil.example/x.svg)"/></svg>',
    ],
    [
      "long XML-entity-hidden url token",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:&#x00000075;rl(https://evil.example/x.svg)"/></svg>',
    ],
    [
      "CSS-escaped @import",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@\\69mport "https\\3a//evil.example/x.css";</style></svg>',
    ],
    [
      "external image-set",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{background:image-set("https://evil.example/x.png")}</style></svg>',
    ],
    [
      "external image function",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{background:image("https://evil.example/x.png")}</style></svg>',
    ],
    [
      "data SVG url",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(data:image/svg+xml;base64,PHN2Zy8+)"/></svg>',
    ],
    [
      "CSS-escaped javascript url",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:u\\72l(ja\\76ascript:alert(1))}</style></svg>',
    ],
    [
      "XML-entity external href",
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https&#58;//evil.example/x.svg"/></svg>',
    ],
    [
      "protocol-relative href",
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="//evil.example/x.svg"/></svg>',
    ],
    [
      "namespace-like text inside a style value",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style=\'fill:url(#ok); xmlns="; background:url(https://evil.example/x.svg)\'/><text>"</text></svg>',
    ],
    [
      "an external stylesheet processing instruction",
      '<?xml-stylesheet type="text/css" href="https://evil.example/x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    ],
    [
      "namespace-prefixed script",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:script/></svg>',
    ],
    ["a DOCTYPE", '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'],
  ])("rejects %s", (_name, svg) => {
    expect(() => inspectSvgSafety(svg, "fixture")).toThrow(/unsafe SVG/u);
  });

  it("reports the decoded URL for the reviewer's CSS-escape example", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\72l(https\\3a//evil.example/x.svg#id)"/></svg>';
    expect(() => inspectSvgSafety(svg, "review")).toThrow(
      /external url\(https:\/\/evil\.example\/x\.svg#id\)/u,
    );
  });

  it.each([
    ["a local fragment", '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(#clip)"/></svg>'],
    [
      "a CSS-escaped local fragment",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\72l(\\000023clip)"/></svg>',
    ],
    [
      "a comment-separated local fragment",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u/**/rl(#clip)"/></svg>',
    ],
    [
      "a raster data href",
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo="/></svg>',
    ],
    [
      "a raster data url",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(data:image/png;base64,iVBORw0KGgo=)"/></svg>',
    ],
    [
      "a local style declaration with a comment",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:currentColor/*local*/}</style></svg>',
    ],
  ])("accepts %s", (_name, svg) => {
    expect(() => inspectSvgSafety(svg, "fixture")).not.toThrow();
  });
});

describe("pinned archive content", () => {
  const archiveFiles = new Map<string, Buffer>([
    ["models.dev-test/LICENSE", Buffer.from("MIT License\nCopyright (c) 2025 models.dev\n")],
    ["models.dev-test/providers/acme/provider.toml", Buffer.from('name = "Acme"\n')],
    [
      "models.dev-test/providers/acme/logo.svg",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>'),
    ],
  ]);

  it("hashes archive content independently of file order", () => {
    const digest = archiveContentDigest(archiveFiles);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(archiveContentDigest(new Map([...archiveFiles].reverse()))).toBe(digest);
    expect(() => verifyArchiveContent(archiveFiles, digest)).not.toThrow();

    const extraFile = new Map(archiveFiles);
    extraFile.set("models.dev-test/README.md", Buffer.from("docs\n"));
    expect(archiveContentDigest(extraFile)).not.toBe(digest);
  });

  it("rejects content that differs from the pinned cryptographic snapshot", () => {
    const digest = archiveContentDigest(archiveFiles);

    const changedLogo = new Map(archiveFiles);
    changedLogo.set(
      "models.dev-test/providers/acme/logo.svg",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2z"/></svg>'),
    );
    expect(() => verifyArchiveContent(changedLogo, digest)).toThrow(/pinned models.dev snapshot/u);

    const changedToml = new Map(archiveFiles);
    changedToml.set(
      "models.dev-test/providers/acme/provider.toml",
      Buffer.from('name = "Other"\n'),
    );
    expect(() => verifyArchiveContent(changedToml, digest)).toThrow(/pinned models.dev snapshot/u);

    expect(() => verifyArchiveContent(archiveFiles)).toThrow(/pinned models.dev snapshot/u);
  });
});

describe("SVG normalization", () => {
  it("strips trailing whitespace outside whitespace-sensitive text content", () => {
    const source = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      '<svg xmlns="http://www.w3.org/2000/svg">   ',
      '  <path d="M0 0h1v1z" />  ',
      "  <text>Hello   ",
      "world</text>",
      '  <g xml:space="preserve">  ',
      '    <path d="M0 0h1v1z" />   ',
      "  </g>",
      "  <g>   ",
      '    <path d="M0 0h1v1z" />  ',
      "  </g>",
      "</svg>",
    ].join("\n");

    const output = normalizedSvg(Buffer.from(source), "fixture");
    expect(output).not.toContain("<?xml");
    expect(output).not.toContain("<!DOCTYPE");
    expect(output).toContain('<svg xmlns="http://www.w3.org/2000/svg">\n');
    expect(output).toContain('<path d="M0 0h1v1z" />\n');
    expect(output).toContain("<text>Hello   \nworld</text>");
    expect(output).toContain('<g xml:space="preserve">  \n');
    expect(output).toContain('<path d="M0 0h1v1z" />   \n');
    expect(output).toContain("<g>\n");
    expect(output.endsWith("\n")).toBe(true);
    expect(normalizedSvg(Buffer.from(source), "fixture")).toBe(output);
  });

  it("leaves no trailing horizontal whitespace in any vendored SVG", () => {
    for (const file of providerLogoFiles) {
      const svg = readFileSync(path.join(logoDir, file), "utf8");
      const offenders = svg
        .split(/\r?\n/)
        .flatMap((line, index) => (/[ \t]+$/u.test(line) ? [index + 1] : []));
      expect(offenders, file).toEqual([]);
    }
  });
});

describe("provider logo cleanup", () => {
  it("removes only stale SVGs from an isolated directory", async () => {
    const assetDir = await mkdtemp(path.join(tmpdir(), "opencode-provider-logos-"));
    try {
      await writeFile(path.join(assetDir, "keep.svg"), "<svg/>");
      await writeFile(path.join(assetDir, "generic.svg"), "<svg/>");
      await writeFile(path.join(assetDir, "stale.svg"), "<svg/>");
      await writeFile(path.join(assetDir, "manifest.json"), "{}");
      await writeFile(path.join(assetDir, "notes.txt"), "keep");

      await removeStaleLogoFiles(assetDir, new Set(["keep.svg", "generic.svg"]));

      expect(existsSync(path.join(assetDir, "keep.svg"))).toBe(true);
      expect(existsSync(path.join(assetDir, "generic.svg"))).toBe(true);
      expect(existsSync(path.join(assetDir, "stale.svg"))).toBe(false);
      expect(existsSync(path.join(assetDir, "manifest.json"))).toBe(true);
      expect(existsSync(path.join(assetDir, "notes.txt"))).toBe(true);
    } finally {
      await removeDirectory(assetDir, { recursive: true, force: true });
    }
  });
});

describe("quota card provider logos", () => {
  it("preserves provider, plan, account, row order and visibility", async () => {
    const html = await renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: quotaCard(),
      preferences,
      hiddenRows: [],
      stale: false,
      timeZone: "UTC",
    });
    const identity = identityMarkup(html);

    expect(plainIdentity(identity)).toBe("OpenCode Go· Plus· Work");
    expect(identity).toContain('class="qg-card__provider">OpenCode Go</span>');
    expect(identity).toContain('class="qg-card__account"');
    expect(identity).toContain("Plus");
    expect(identity).toContain("Work");
    expect(identity).toContain('data-provider-logo="opencode-go"');
    expect(identity).toContain("/assets/providers/opencode-go.svg");
    expect(identity).not.toContain("<svg");
    expect(html).not.toMatch(REMOTE_URL);
    expect(html.indexOf("Five hour window")).toBeLessThan(html.indexOf("Weekly window"));

    const hidden = await renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: quotaCard(),
      preferences,
      hiddenRows: ["weekly"],
      stale: false,
      timeZone: "UTC",
    });
    expect(hidden).toContain("Five hour window");
    expect(hidden).not.toContain("Weekly window");
  });

  it("keeps card order and hidden-card visibility unchanged", async () => {
    const opencode = quotaCard({
      cardId: "opencode#card" as never,
      providerId: "opencode",
      providerLabel: "OpenCode Zen",
      rows: [],
    });
    const chutes = quotaCard({
      cardId: "chutes#card" as never,
      providerId: "chutes",
      providerLabel: "Chutes",
      planLabel: undefined,
      accountLabel: undefined,
      rows: [],
    });
    const snapshot = {
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers: { cards: [opencode, chutes], enabledProviders: "auto" as const, polledAtMs: NOW },
    };
    const html = await renderView("/views/home.tsx", "QuotaView", {
      snapshot,
      preferences,
      hiddenCards: [],
      hiddenRows: [],
      stale: false,
    });
    expect(html.match(/class="qg-card"/gu)).toHaveLength(2);
    expect(html.indexOf("OpenCode Zen")).toBeLessThan(html.indexOf("Chutes"));

    const hidden = await renderView("/views/home.tsx", "QuotaView", {
      snapshot,
      preferences,
      hiddenCards: [chutes.cardId],
      hiddenRows: [],
      stale: false,
    });
    expect(hidden.match(/class="qg-card"/gu)).toHaveLength(1);
    expect(hidden).toContain("OpenCode Zen");
    expect(hidden).not.toContain("Chutes");
  });

  it("uses the generic fallback for a raw id that is not an asset name", async () => {
    const html = await renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: quotaCard({
        cardId: "odd#card" as never,
        providerId: "../../etc/passwd",
        providerLabel: "Odd Provider",
        planLabel: undefined,
        accountLabel: undefined,
        rows: [],
      }),
      preferences,
      hiddenRows: [],
      stale: false,
      timeZone: "UTC",
    });
    expect(html).toContain('data-provider-logo="generic"');
    expect(html).toContain("/assets/providers/generic.svg");
    expect(html).not.toContain("../../etc/passwd.svg");
    expect(html).not.toContain("<svg");
    expect(html).not.toMatch(REMOTE_URL);
  });
});
