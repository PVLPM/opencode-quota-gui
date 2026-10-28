import {
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
  resolveAlibabaCodingPlanAuthCached,
} from "../lib/alibaba-auth.js";
import { resolveAnthropicAuthIdentity } from "../lib/anthropic.js";
import { resolveChutesApiKey } from "../lib/chutes-config.js";
import { resolveCopilotAuthIdentity } from "../lib/copilot.js";
import { resolveDeepSeekApiKey } from "../lib/deepseek-auth.js";
import type { QuotaProviderCachePolicy } from "../lib/entries.js";
import { resolveGoogleAgyAuthIdentity } from "../lib/google-agy.js";
import { resolveGeminiCliAuthIdentity } from "../lib/google-gemini-cli.js";
import { resolveKiloApiKey } from "../lib/kilo-config.js";
import {
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
  resolveKimiCnAuthCached,
  resolveKimiGlobalAuthCached,
} from "../lib/kimi-auth.js";
import {
  DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
  resolveMimoConfigCached,
} from "../lib/mimo-config.js";
import {
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  resolveMiniMaxAuthCached,
  resolveMiniMaxChinaAuthCached,
} from "../lib/minimax-auth.js";
import { resolveNanoGptApiKey } from "../lib/nanogpt-config.js";
import { resolveOllamaCloudApiKey } from "../lib/ollama-cloud-config.js";
import { resolveOpenAIAuthIdentity } from "../lib/openai.js";
import {
  consoleBaseUrl,
  resolveOpenCodeConsoleAuthAccounts,
} from "../lib/opencode-console-auth.js";
import {
  DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
  resolveOpenCodeGoAuthCached,
} from "../lib/opencode-go-auth.js";
import { resolveOpenRouterAuthIdentity } from "../lib/openrouter.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-registration.js";
import type {
  QuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../lib/quota-providers.js";
import { resolveQuotaProviderApiKey } from "../lib/quota-providers-remote.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  type ResolvedAuthIdentity,
  type ResolvedAuthPrincipal,
} from "../lib/resolved-auth-identity.js";
import { resolveSyntheticApiKey } from "../lib/synthetic-config.js";
import { resolveXaiAuthIdentity } from "../lib/xai.js";
import { DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS, resolveZaiAuthCached } from "../lib/zai-auth.js";
import { DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS, resolveZhipuAuthCached } from "../lib/zhipu-auth.js";

const UNCACHED = { kind: "uncached" } as const satisfies QuotaProviderCachePolicy;

type ResolvedCredential = {
  credential: string;
  principalKind?: "stable-id" | "credential";
  qualifiers?: readonly string[];
};

function resolvedCredentialPolicy(
  providerId: CanonicalQuotaProviderId,
  resolve: () => Promise<ResolvedCredential | null>,
): QuotaProviderCachePolicy {
  return {
    kind: "resolved-auth",
    async resolveIdentity() {
      const resolved = await resolve();
      if (!resolved) return null;
      return deriveResolvedAuthIdentity({
        providerId,
        principal: {
          kind: resolved.principalKind ?? "credential",
          value: resolved.credential,
        },
        qualifiers: resolved.qualifiers,
      });
    },
  };
}

async function consoleAccountIdentities(
  providerId: CanonicalQuotaProviderId,
  accounts: Awaited<ReturnType<typeof resolveOpenCodeConsoleAuthAccounts>>,
): Promise<ResolvedAuthIdentity[]> {
  const identities: ResolvedAuthIdentity[] = [];
  for (const account of accounts) {
    if (account.state !== "configured") continue;
    const { credential } = account;
    // Distinguish accounts within the same org (member budgets are queried per
    // account): org + member, else the account, else the token. A login with an
    // org but no account id proves its member by its token, so two members are
    // never collapsed. The Console URL qualifies it because org ids can collide
    // across Console URLs.
    const member = credential.accountId ?? credential.accessToken;
    const principal: ResolvedAuthPrincipal = credential.orgId
      ? { kind: "stable-id", value: JSON.stringify([credential.orgId, member]) }
      : credential.accountId
        ? { kind: "stable-id", value: credential.accountId }
        : { kind: "credential", value: credential.accessToken };
    const identity = await deriveResolvedAuthIdentity({
      providerId,
      principal,
      qualifiers: [consoleBaseUrl(credential)],
    });
    if (identity) identities.push(identity);
  }
  return identities;
}

/**
 * Every account descriptor, including failed and expired rows, contributes to
 * the Console cache identity. `sourceId`, label, active mark, and state are all
 * display/selection inputs, so a change to any of them must not reuse a cached
 * result built from the previous account set. Identity reads use the resolver's
 * no-enrichment mode so a Console rename cannot change a persisted cache key.
 */
function consoleAccountCacheQualifiers(
  accounts: Awaited<ReturnType<typeof resolveOpenCodeConsoleAuthAccounts>>,
): string[] {
  return accounts.map((account) =>
    JSON.stringify({
      active: account.active,
      label: account.label,
      sourceId: account.sourceId,
      state: account.state,
    }),
  );
}

async function composeAuthIdentities(
  providerId: CanonicalQuotaProviderId,
  identities: readonly ResolvedAuthIdentity[],
  qualifiers: readonly string[] = [],
): Promise<ResolvedAuthIdentity | null> {
  if (identities.length === 0) return null;
  if (identities.length === 1 && qualifiers.length === 0) return identities[0] ?? null;
  return composeResolvedAuthIdentities({ providerId, identities, qualifiers });
}

export async function resolveQuotaProviderDefinitionAuthIdentity(
  definition: QuotaProviderDefinition,
): Promise<ResolvedAuthIdentity | null> {
  if (definition.mode === "local-estimate") {
    return deriveResolvedAuthIdentity({
      providerId: `quota-providers:${definition.id}`,
      principal: { kind: "stable-id", value: "local-estimate" },
    });
  }

  const resolved = await resolveQuotaProviderApiKey(definition as RemoteApiQuotaProviderDefinition);
  return deriveResolvedAuthIdentity({
    providerId: `quota-providers:${definition.id}`,
    principal: resolved.key
      ? { kind: "credential", value: resolved.key }
      : { kind: "stable-id", value: "missing-credential" },
    qualifiers: [definition.providerId],
  });
}

const quotaProvidersCachePolicy: QuotaProviderCachePolicy = {
  kind: "resolved-auth",
  async resolveIdentity(_ctx, cacheContext) {
    const definitions = cacheContext.runtimeEligibleQuotaProviders;
    if (!definitions || definitions.length === 0) return null;

    const identities = await Promise.all(
      definitions.map(resolveQuotaProviderDefinitionAuthIdentity),
    );
    if (identities.some((identity) => identity === null)) return null;

    return composeResolvedAuthIdentities({
      providerId: "quota-providers",
      identities: identities as ResolvedAuthIdentity[],
    });
  },
};

export const PROVIDER_CACHE_POLICIES = {
  anthropic: {
    kind: "resolved-auth",
    resolveIdentity: (ctx) =>
      resolveAnthropicAuthIdentity({ binaryPath: ctx.config.anthropicBinaryPath }),
  },
  copilot: {
    kind: "resolved-auth",
    resolveIdentity: () => resolveCopilotAuthIdentity(),
  },
  openai: {
    kind: "resolved-auth",
    resolveIdentity: () => resolveOpenAIAuthIdentity(),
  },
  openrouter: {
    kind: "resolved-auth",
    resolveIdentity: () => resolveOpenRouterAuthIdentity(),
  },
  kilo: resolvedCredentialPolicy("kilo", async () => {
    const resolved = await resolveKiloApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  cursor: UNCACHED,
  "alibaba-token-plan": UNCACHED,
  "alibaba-coding-plan": resolvedCredentialPolicy("alibaba-coding-plan", async () => {
    const resolved = await resolveAlibabaCodingPlanAuthCached({
      maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [resolved.tier] }
      : null;
  }),
  synthetic: resolvedCredentialPolicy("synthetic", async () => {
    const resolved = await resolveSyntheticApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  chutes: resolvedCredentialPolicy("chutes", async () => {
    const resolved = await resolveChutesApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  "google-gemini-cli": {
    kind: "resolved-auth",
    resolveIdentity: () => resolveGeminiCliAuthIdentity(),
  },
  "google-agy": {
    kind: "resolved-auth",
    resolveIdentity: () => resolveGoogleAgyAuthIdentity(),
  },
  zai: resolvedCredentialPolicy("zai", async () => {
    const resolved = await resolveZaiAuthCached({ maxAgeMs: DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS });
    return resolved.state === "configured" ? { credential: resolved.apiKey } : null;
  }),
  zhipu: resolvedCredentialPolicy("zhipu", async () => {
    const resolved = await resolveZhipuAuthCached({
      maxAgeMs: DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured" ? { credential: resolved.apiKey } : null;
  }),
  nanogpt: resolvedCredentialPolicy("nanogpt", async () => {
    const resolved = await resolveNanoGptApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  "minimax-coding-plan": resolvedCredentialPolicy("minimax-coding-plan", async () => {
    const resolved = await resolveMiniMaxAuthCached({
      maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [resolved.endpoint] }
      : null;
  }),
  "minimax-china-coding-plan": resolvedCredentialPolicy("minimax-china-coding-plan", async () => {
    const resolved = await resolveMiniMaxChinaAuthCached({
      maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [resolved.endpoint] }
      : null;
  }),
  "kimi-code-plan-global": resolvedCredentialPolicy("kimi-code-plan-global", async () => {
    const resolved = await resolveKimiGlobalAuthCached({
      maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [resolved.endpoint] }
      : null;
  }),
  "kimi-code-plan-cn": resolvedCredentialPolicy("kimi-code-plan-cn", async () => {
    const resolved = await resolveKimiCnAuthCached({
      maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [resolved.endpoint] }
      : null;
  }),
  deepseek: resolvedCredentialPolicy("deepseek", async () => {
    const resolved = await resolveDeepSeekApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  xai: {
    kind: "resolved-auth",
    resolveIdentity: () => resolveXaiAuthIdentity(),
  },
  xiaomi: resolvedCredentialPolicy("xiaomi", async () => {
    const resolved = await resolveMimoConfigCached({
      maxAgeMs: DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured" ? { credential: resolved.config.cookie } : null;
  }),
  "opencode-go": {
    kind: "resolved-auth",
    async resolveIdentity() {
      const [consoleAccounts, legacy] = await Promise.all([
        resolveOpenCodeConsoleAuthAccounts({ enrichOrgNames: false }),
        resolveOpenCodeGoAuthCached({
          maxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
        }),
      ]);
      const identities = await consoleAccountIdentities("opencode-go", consoleAccounts);
      if (legacy.state === "configured") {
        const legacyIdentity = await deriveResolvedAuthIdentity({
          providerId: "opencode-go",
          principal: { kind: "credential", value: legacy.apiKey },
        });
        if (legacyIdentity) identities.push(legacyIdentity);
      }
      return composeAuthIdentities(
        "opencode-go",
        identities,
        consoleAccountCacheQualifiers(consoleAccounts),
      );
    },
  },
  opencode: {
    kind: "resolved-auth",
    async resolveIdentity() {
      const accounts = await resolveOpenCodeConsoleAuthAccounts({ enrichOrgNames: false });
      return composeAuthIdentities(
        "opencode",
        await consoleAccountIdentities("opencode", accounts),
        consoleAccountCacheQualifiers(accounts),
      );
    },
  },
  "ollama-cloud": resolvedCredentialPolicy("ollama-cloud", async () => {
    const resolved = await resolveOllamaCloudApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  "quota-providers": quotaProvidersCachePolicy,
} satisfies Record<CanonicalQuotaProviderId, QuotaProviderCachePolicy>;
