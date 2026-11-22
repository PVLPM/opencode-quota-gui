/**
 * Anthropic API-key discovery for the Anthropic API card. It is independent of the Claude Agent
 * CLI login and of OpenCode's Anthropic OAuth entry (`./anthropic-auth.ts`): only an API key counts.
 */

import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getCredentialDatabasePaths, readAuthFile } from "./opencode-auth.js";

const ALLOWED_ANTHROPIC_ENV_VARS = ["ANTHROPIC_API_KEY"] as const;
const ANTHROPIC_PROVIDER_KEYS = ["anthropic"] as const;

type AnthropicApiKeySource =
  | "env:ANTHROPIC_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

const anthropicApiKeyResolver = createProviderApiKeyResolver<AnthropicApiKeySource>({
  envVars: [{ name: "ANTHROPIC_API_KEY", source: "env:ANTHROPIC_API_KEY" }],
  providerKeys: ANTHROPIC_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_ANTHROPIC_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  // The strict policy accepts only `type: "api"` entries, so an OAuth login never counts.
  auth: {
    readAuth: () => readAuthFile({ integrationIds: ANTHROPIC_PROVIDER_KEYS }),
    getCredentialDatabasePaths,
    authSource: "opencode.db",
  },
});

/** The configured Anthropic API key, or null. Callers must never log or display it. */
export async function resolveAnthropicApiKey(): Promise<string | null> {
  return (await anthropicApiKeyResolver.resolve())?.key ?? null;
}
