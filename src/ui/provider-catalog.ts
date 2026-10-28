import localOverrides from "./assets/provider-logos/local-overrides.json";
import generatedCatalog from "./provider-logos.generated.json";

/**
 * Shared, browser-safe provider presentation.
 *
 * The catalog is presentation only. It resolves an exact raw provider id to a
 * human label and a local logo URL, while returning the raw id unchanged so
 * analytics identity, route tokens and grouping keys never move. The logo URLs
 * are exact literals from the pinned models.dev catalog or the pinned local
 * override file; this module never builds a path from an id.
 */

export const PROVIDER_LOGO_FALLBACK_KEY = "generic";
export const PROVIDER_LOGO_FALLBACK_URL = "/assets/providers/generic.svg";

const SAFE_LOGO_URL = /^\/assets\/providers\/[a-z0-9][a-z0-9.-]*\.svg$/u;

interface GeneratedLogo {
  label: string;
  url: string;
}

interface ProviderAlias {
  label: string;
  /** Omit for a known provider that has no specific upstream mark. */
  logoKey?: string;
}

const UPSTREAM_LOGOS: Readonly<Record<string, GeneratedLogo>> = generatedCatalog.logos;

/**
 * Local presentation artwork that replaces an upstream mark by **logo key**,
 * never by raw provider identity. The upstream file stays vendored so the
 * models.dev sync and its manifest remain reproducible.
 */
const PROVIDER_LOGO_OVERRIDES: Readonly<Record<string, string>> = {
  "opencode-go": "opencode-go-g",
};

const LOCAL_LOGOS: Readonly<Record<string, GeneratedLogo>> = localOverrides.logos;

/**
 * Product labels for upstream ids whose internal name differs. These are still
 * direct catalog entries: the logo and label belong to the same raw provider id.
 */
const PROVIDER_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  "github-copilot": "GitHub Copilot",
  "minimax-coding-plan": "MiniMax Token Plan",
  "minimax-cn-coding-plan": "MiniMax Token Plan (CN)",
  "kimi-code-plan-global": "Kimi Code",
  "kimi-code-plan-cn": "Kimi Code (CN)",
  "alibaba-token-plan": "Alibaba Personal Token Plan",
  zai: "Z.ai",
  zhipuai: "Zhipu",
};

/**
 * Upstream marks with an opaque raster or full-bleed background silhouette into
 * a solid block under a one-colour alpha mask. The generic mark is more legible
 * and truthful than a blob; the upstream files remain vendored and attributed.
 */
const MASK_UNSUITABLE_LOGO_IDS: ReadonlySet<string> = new Set([
  "atomic-chat",
  "orcarouter",
  "zenmux",
]);

/**
 * Explicit internal ids and legacy names. A direct upstream id always wins, so
 * an alias can never relabel a real provider such as upstream `google` or
 * `alibaba`; aliases only fill in names OpenCode's own integrations introduced.
 */
const PROVIDER_ALIASES: Readonly<Record<string, ProviderAlias>> = {
  anthropic: { label: "Anthropic", logoKey: "anthropic" },
  claude: { label: "Anthropic", logoKey: "anthropic" },
  "claude-code": { label: "Anthropic", logoKey: "anthropic" },
  copilot: { label: "Copilot", logoKey: "github-copilot" },
  "copilot-chat": { label: "Copilot", logoKey: "github-copilot" },
  "github-copilot-chat": { label: "Copilot", logoKey: "github-copilot" },
  chatgpt: { label: "OpenAI", logoKey: "openai" },
  codex: { label: "OpenAI", logoKey: "openai" },
  cursor: { label: "Cursor" },
  "cursor-acp": { label: "Cursor" },
  "open-cursor": { label: "Cursor" },
  "@rama_nigg/open-cursor": { label: "Cursor" },
  synthetic: { label: "Synthetic" },
  chutes: { label: "Chutes" },
  "chutes-ai": { label: "Chutes" },
  "gemini-cli": { label: "Gemini CLI", logoKey: "google" },
  gemini: { label: "Gemini CLI", logoKey: "google" },
  "google-gemini": { label: "Gemini CLI", logoKey: "google" },
  "opencode-gemini-auth": { label: "Gemini CLI", logoKey: "google" },
  "google-gemini-cli": { label: "Gemini CLI", logoKey: "google" },
  "google-agy": { label: "Google AGY", logoKey: "google" },
  "opencode-agy-auth": { label: "Google AGY", logoKey: "google" },
  "google-agy-auth": { label: "Google AGY", logoKey: "google" },
  nanogpt: { label: "NanoGPT", logoKey: "nano-gpt" },
  "nano-gpt": { label: "NanoGPT", logoKey: "nano-gpt" },
  "opencode-zen": { label: "OpenCode Zen", logoKey: "opencode" },
  "opencode-go-subscription": { label: "OpenCode Go", logoKey: "opencode-go" },
  "minimax-china-coding-plan": {
    label: "MiniMax Token Plan (CN)",
    logoKey: "minimax-cn-coding-plan",
  },
  "minimax-cn": { label: "MiniMax Token Plan (CN)", logoKey: "minimax-cn-coding-plan" },
  "minimax-china": { label: "MiniMax Token Plan (CN)", logoKey: "minimax-cn-coding-plan" },
  kimi: { label: "Kimi Code (CN)", logoKey: "kimi-code-plan-cn" },
  "kimi-code": { label: "Kimi Code (CN)", logoKey: "kimi-code-plan-cn" },
  "kimi-for-code": { label: "Kimi Code (CN)", logoKey: "kimi-code-plan-cn" },
  "kimi-for-coding": { label: "Kimi Code (CN)", logoKey: "kimi-code-plan-cn" },
  glm: { label: "Z.ai", logoKey: "zai" },
  "zai-coding-plan": { label: "Z.ai", logoKey: "zai" },
  zhipu: { label: "Zhipu", logoKey: "zhipuai" },
  "glm-coding-plan": { label: "Zhipu", logoKey: "zhipuai" },
  "zhipu-coding-plan": { label: "Zhipu", logoKey: "zhipuai" },
  "zhipuai-coding-plan": { label: "Zhipu", logoKey: "zhipuai" },
  "deep-seek": { label: "DeepSeek", logoKey: "deepseek" },
  "quota-providers": { label: "Quota providers" },
};

export interface ProviderPresentation {
  /** The exact raw id that came in; presentation never normalizes identity. */
  readonly providerId: string;
  readonly label: string;
  readonly logoKey: string;
  /** A same-origin packaged file; never a remote URL or an id-derived path. */
  readonly logoSrc: string;
  readonly hasSpecificLogo: boolean;
}

function safeLogoUrl(url: string | undefined): string | undefined {
  return url !== undefined && SAFE_LOGO_URL.test(url) ? url : undefined;
}

/** Read only an own property, so `constructor`/`__proto__` never become entries. */
function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function fallbackLabel(rawId: string): string {
  return rawId.trim().length === 0 ? "Unknown provider" : rawId;
}

/** Resolve an upstream logo key through the explicit local override map. */
function resolveLogo(
  logoKey: string | undefined,
): { key: string; logo: GeneratedLogo } | undefined {
  if (logoKey === undefined) return undefined;
  const key = ownValue(PROVIDER_LOGO_OVERRIDES, logoKey) ?? logoKey;
  const logo = ownValue(UPSTREAM_LOGOS, key) ?? ownValue(LOCAL_LOGOS, key);
  return logo === undefined ? undefined : { key, logo };
}

/**
 * Resolve presentation for an arbitrary raw provider id. Unknown and empty ids
 * keep their raw identity in `providerId` and use the local neutral fallback.
 */
export function resolveProviderPresentation(rawId: string): ProviderPresentation {
  const direct = ownValue(UPSTREAM_LOGOS, rawId);
  if (direct !== undefined) {
    const target = resolveLogo(rawId);
    const logoSrc = safeLogoUrl(target?.logo.url);
    const logoKey = target?.key ?? rawId;
    if (logoSrc !== undefined && !MASK_UNSUITABLE_LOGO_IDS.has(rawId)) {
      return {
        providerId: rawId,
        label: ownValue(PROVIDER_LABEL_OVERRIDES, rawId) ?? direct.label,
        logoKey,
        logoSrc,
        hasSpecificLogo: true,
      };
    }
    return {
      providerId: rawId,
      label: ownValue(PROVIDER_LABEL_OVERRIDES, rawId) ?? direct.label,
      logoKey: PROVIDER_LOGO_FALLBACK_KEY,
      logoSrc: PROVIDER_LOGO_FALLBACK_URL,
      hasSpecificLogo: false,
    };
  }

  const alias = ownValue(PROVIDER_ALIASES, rawId);
  if (alias !== undefined) {
    const target = resolveLogo(alias.logoKey);
    const logoSrc = safeLogoUrl(target?.logo.url);
    if (target !== undefined && logoSrc !== undefined) {
      return {
        providerId: rawId,
        label: alias.label,
        logoKey: target.key,
        logoSrc,
        hasSpecificLogo: true,
      };
    }
    return {
      providerId: rawId,
      label: alias.label,
      logoKey: PROVIDER_LOGO_FALLBACK_KEY,
      logoSrc: PROVIDER_LOGO_FALLBACK_URL,
      hasSpecificLogo: false,
    };
  }

  return {
    providerId: rawId,
    label: fallbackLabel(rawId),
    logoKey: PROVIDER_LOGO_FALLBACK_KEY,
    logoSrc: PROVIDER_LOGO_FALLBACK_URL,
    hasSpecificLogo: false,
  };
}
