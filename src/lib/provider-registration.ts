import {
  CLAUDE_AGENT_RESETS_INFO,
  CLAUDE_AGENT_RESETS_ROW_KEY,
  OPENAI_CREDITS_INFO,
  OPENAI_CREDITS_ROW_KEY,
  OPENAI_CREDITS_ROW_LABEL,
  OPENAI_CREDITS_ROW_RESULT_TYPE,
  OPENAI_RESETS_INFO,
  OPENAI_RESETS_ROW_KEY,
  OPENAI_RESETS_ROW_LABEL,
  OPENAI_RESETS_ROW_RESULT_TYPE,
} from "../contracts/openai-quota.js";

type QuotaProviderOptionalVisibilityRowResultType =
  | "quota"
  | "rate_limit"
  | "usage"
  | "spend"
  | "budget"
  | "balance"
  | "status";

/** The render shape the live row uses, so the declared eye shares its row id. */
type QuotaProviderOptionalVisibilityRowKind = "percent" | "value" | "quantity" | "boolean";

/**
 * One persistent Settings eye for an optional field a provider emits only when
 * the provider reports it. The primary row id is the declared field id and
 * stays stable when the provider renders the field in another shape; each
 * alternate shape is an alias of the same control.
 */
export interface QuotaProviderOptionalVisibilityRow {
  rowKey: string;
  resultType: QuotaProviderOptionalVisibilityRowResultType;
  /** Defaults to `value` for rows whose runtime shape is a formatted value. */
  kind?: QuotaProviderOptionalVisibilityRowKind;
  /** Other render shapes this field can emit when its primary value is absent. */
  alternateShapes?: readonly {
    resultType: QuotaProviderOptionalVisibilityRowResultType;
    kind?: QuotaProviderOptionalVisibilityRowKind;
  }[];
  label: string;
  info: string;
}

export type QuotaProviderAutoSetup =
  | "yes"
  | "usually"
  | "manual_env_config"
  | "needs_quick_setup"
  | "unavailable";

export type QuotaProviderAuthentication =
  | "opencode_auth_oauth_token"
  | "opencode_auth_api_key"
  | "companion_auth_oauth_token"
  | "local_cli_auth"
  | "github_oauth_or_pat"
  | "external_api_key"
  | "state_only"
  | "unavailable";

export type QuotaProviderAuthFallback = "env_api_key" | "global_opencode_config";

export type QuotaProviderQuotaSource =
  | "remote_api"
  | "local_estimation"
  | "local_runtime_accounting"
  | "local_cli_report"
  | "unavailable";

export type QuotaProviderAutoResumeBinding =
  | "account"
  | "single-source"
  | "account-or-single-source";

export interface QuotaProviderShapeSource {
  recommendedReplacementId?: string;
  autoSetup: QuotaProviderAutoSetup;
  authentication: QuotaProviderAuthentication;
  authFallbacks?: readonly QuotaProviderAuthFallback[];
  quota: QuotaProviderQuotaSource;
  /**
   * Auto-resume evidence this provider can supply. Absent means it never qualifies: no primary
   * reset window, no verifiable identity, or both.
   */
  autoResume?: QuotaProviderAutoResumeBinding;
  optionalVisibilityRows?: readonly QuotaProviderOptionalVisibilityRow[];
  quickSetupAnchor?: string;
  notes?: string;
}

export interface QuotaProviderRegistrationSourceEntry {
  id: string;
  label: string;
  labelAliases?: readonly string[];
  runtimeIds: readonly string[];
  synonyms: readonly string[];
  liveLocalUsage?: true;
  shape: QuotaProviderShapeSource;
}

const GLM_OPTIONAL_VISIBILITY_ROWS = [
  {
    rowKey: "window:five_hour",
    resultType: "quota",
    kind: "percent",
    label: "5h",
    info: "GLM coding-plan 5-hour window, when the plan reports it.",
  },
  {
    rowKey: "window:week",
    resultType: "quota",
    kind: "percent",
    label: "Weekly",
    info: "GLM coding-plan weekly window, when the plan reports it.",
  },
  {
    rowKey: "window:mcp",
    resultType: "quota",
    kind: "percent",
    label: "MCP",
    info: "GLM coding-plan MCP quota, when the plan reports it.",
  },
] satisfies readonly QuotaProviderOptionalVisibilityRow[];

const GLM_CODING_PLAN_SHAPE = {
  autoSetup: "yes",
  authentication: "opencode_auth_api_key",
  authFallbacks: ["env_api_key", "global_opencode_config"],
  quota: "remote_api",
  autoResume: "account-or-single-source",
  optionalVisibilityRows: GLM_OPTIONAL_VISIBILITY_ROWS,
} as const satisfies QuotaProviderShapeSource;

const SINGLE_SOURCE_KEY_SHAPE = {
  autoSetup: "usually",
  authentication: "opencode_auth_api_key",
  authFallbacks: ["env_api_key", "global_opencode_config"],
  quota: "remote_api",
  autoResume: "single-source",
} as const satisfies QuotaProviderShapeSource;

const CLI_WINDOW_ROWS = [
  { window: "five_hour", label: "5h", unit: "5-hour" },
  { window: "week", label: "Weekly", unit: "weekly" },
  { window: "month", label: "Monthly", unit: "monthly" },
] as const;

/**
 * The optional window rows a local-CLI plan declares. Both Alibaba plans share
 * the row contract (ids, result type and alternate status shape) and differ
 * only in their plan name and which windows the CLI reports, so one factory
 * keeps their declared ids aligned.
 */
function cliWindowRows(
  planLabel: string,
  windows: readonly (typeof CLI_WINDOW_ROWS)[number]["window"][],
): readonly QuotaProviderOptionalVisibilityRow[] {
  return CLI_WINDOW_ROWS.filter((row) => windows.includes(row.window)).map(
    (row): QuotaProviderOptionalVisibilityRow => ({
      rowKey: `window:${row.window}`,
      resultType: "quota",
      kind: "percent",
      alternateShapes: [{ resultType: "status", kind: "value" }],
      label: row.label,
      info: `${planLabel} ${row.unit} window, when the CLI reports it.`,
    }),
  );
}

export const QUOTA_PROVIDER_REGISTRATION_SOURCE = [
  {
    id: "anthropic",
    label: "Anthropic",
    runtimeIds: ["anthropic"],
    synonyms: [],
    shape: {
      autoSetup: "usually",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      optionalVisibilityRows: [
        {
          rowKey: "rate_limit:requests",
          resultType: "rate_limit",
          label: "Requests",
          info: "Passive per-minute request rate limit observed on API-key traffic.",
        },
        {
          rowKey: "rate_limit:tokens",
          resultType: "rate_limit",
          label: "Tokens",
          info: "Passive per-minute token rate limit observed on API-key traffic.",
        },
        {
          rowKey: "rate_limit:inputTokens",
          resultType: "rate_limit",
          label: "Input tokens",
          info: "Passive per-minute input-token rate limit observed on API-key traffic.",
        },
        {
          rowKey: "rate_limit:outputTokens",
          resultType: "rate_limit",
          label: "Output tokens",
          info: "Passive per-minute output-token rate limit observed on API-key traffic.",
        },
      ],
      notes:
        "Passive per-minute rate-limit headers from real API-key requests; no spend or balance",
    },
  },
  {
    id: "claude-agent",
    label: "Claude Agent",
    runtimeIds: ["claude-agent", "claude-code"],
    synonyms: ["claude-code", "claude"],
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "local_cli_auth",
      quota: "local_cli_report",
      autoResume: "single-source",
      quickSetupAnchor: "claude-agent",
      optionalVisibilityRows: [
        {
          rowKey: "window:five_hour",
          resultType: "quota",
          kind: "percent",
          label: "5h",
          info: "Claude Agent 5-hour subscription window.",
        },
        {
          rowKey: "window:week",
          resultType: "quota",
          kind: "percent",
          label: "Weekly",
          info: "Claude Agent weekly subscription window.",
        },
        {
          rowKey: "window:month",
          resultType: "quota",
          kind: "percent",
          label: "Monthly credits",
          info: "Claude Agent monthly usage credits, when the plan reports them.",
        },
        {
          rowKey: "named:Fable weekly",
          resultType: "quota",
          kind: "percent",
          label: "Fable",
          info: "Claude Agent Fable weekly window, when the plan reports it.",
        },
        {
          rowKey: CLAUDE_AGENT_RESETS_ROW_KEY,
          resultType: OPENAI_RESETS_ROW_RESULT_TYPE,
          label: OPENAI_RESETS_ROW_LABEL,
          info: CLAUDE_AGENT_RESETS_INFO,
        },
      ],
    },
  },
  {
    id: "copilot",
    label: "Copilot",
    runtimeIds: ["copilot", "github-copilot", "copilot-chat", "github-copilot-chat"],
    synonyms: ["github-copilot", "copilot-chat", "github-copilot-chat"],
    shape: {
      autoSetup: "usually",
      authentication: "github_oauth_or_pat",
      quota: "remote_api",
      autoResume: "account",
      optionalVisibilityRows: [
        {
          rowKey: "window:month",
          resultType: "quota",
          kind: "percent",
          alternateShapes: [{ resultType: "quota", kind: "value" }],
          label: "Monthly quota",
          info: "Copilot premium-request or AI-credit quota for the current month.",
        },
        {
          rowKey: "named:additional_usage",
          resultType: "budget",
          kind: "percent",
          alternateShapes: [{ resultType: "budget", kind: "value" }],
          label: "Additional usage",
          info: "Copilot additional-usage budget, when billing reports spend against it.",
        },
      ],
      notes: "OAuth for personal flow; PAT for managed billing",
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    runtimeIds: ["openai", "chatgpt", "codex"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_oauth_token",
      quota: "remote_api",
      autoResume: "account",
      optionalVisibilityRows: [
        {
          rowKey: "window:five_hour",
          resultType: "rate_limit",
          kind: "percent",
          label: "5h",
          info: "OpenAI 5-hour rate-limit window, when the account reports it.",
        },
        {
          rowKey: "window:week",
          resultType: "rate_limit",
          kind: "percent",
          label: "Weekly",
          info: "OpenAI weekly rate-limit window, when the account reports it.",
        },
        {
          rowKey: "window:month",
          resultType: "rate_limit",
          kind: "percent",
          label: "Monthly",
          info: "OpenAI monthly rate-limit window, when the account reports it.",
        },
        {
          rowKey: "window:code_review",
          resultType: "rate_limit",
          kind: "percent",
          label: "Code Review",
          info: "OpenAI Code Review rate-limit window, when the account reports it.",
        },
        {
          rowKey: OPENAI_RESETS_ROW_KEY,
          resultType: OPENAI_RESETS_ROW_RESULT_TYPE,
          label: OPENAI_RESETS_ROW_LABEL,
          info: OPENAI_RESETS_INFO,
        },
        {
          rowKey: OPENAI_CREDITS_ROW_KEY,
          resultType: OPENAI_CREDITS_ROW_RESULT_TYPE,
          label: OPENAI_CREDITS_ROW_LABEL,
          info: OPENAI_CREDITS_INFO,
        },
      ],
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    runtimeIds: ["openrouter"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "kilo",
    label: "Kilo Gateway",
    runtimeIds: ["kilo"],
    synonyms: [],
    shape: {
      autoSetup: "usually",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      optionalVisibilityRows: [
        {
          rowKey: "component:remaining_credits",
          resultType: "quota",
          kind: "percent",
          label: "Remaining credits",
          info: "Kilo Pass credit balance, when an active pass reports a total.",
        },
        {
          rowKey: "component:total_balance",
          resultType: "balance",
          kind: "quantity",
          label: "Balance",
          info: "Kilo Gateway prepaid balance, when no active Pass is present.",
        },
      ],
      notes:
        "Queries Kilo Pass state first, then falls back to the documented personal Gateway balance when no active subscription exists",
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    runtimeIds: ["cursor", "cursor-acp"],
    synonyms: ["cursor-acp", "open-cursor", "@rama_nigg/open-cursor"],
    liveLocalUsage: true,
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "local_runtime_accounting",
      quickSetupAnchor: "cursor",
      notes: "companion runtime/plugin integration plus local usage accounting",
    },
  },
  {
    id: "alibaba-coding-plan",
    label: "Alibaba Coding Plan",
    runtimeIds: ["alibaba-coding-plan"],
    synonyms: ["alibaba"],
    liveLocalUsage: true,
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "local_cli_auth",
      quota: "local_cli_report",
      optionalVisibilityRows: cliWindowRows("Coding Plan", ["five_hour", "week", "month"]),
      quickSetupAnchor: "alibaba-coding-plan",
    },
  },
  {
    id: "alibaba-token-plan",
    label: "Alibaba Personal Token Plan",
    runtimeIds: ["alibaba-token-plan"],
    synonyms: [],
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "local_cli_auth",
      quota: "local_cli_report",
      optionalVisibilityRows: cliWindowRows("Personal Token Plan", ["five_hour", "week"]),
      quickSetupAnchor: "alibaba-personal-token-plan",
    },
  },
  {
    id: "synthetic",
    label: "Synthetic",
    runtimeIds: ["synthetic"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      autoResume: "single-source",
      optionalVisibilityRows: [
        {
          rowKey: "window:five_hour",
          resultType: "quota",
          kind: "percent",
          label: "5h",
          info: "Synthetic 5-hour window, when the API reports it.",
        },
        {
          rowKey: "window:week",
          resultType: "quota",
          kind: "percent",
          label: "Weekly",
          info: "Synthetic weekly window, when the API reports it.",
        },
      ],
    },
  },
  {
    id: "chutes",
    label: "Chutes",
    runtimeIds: ["chutes", "chutes-ai"],
    synonyms: [],
    shape: {
      ...SINGLE_SOURCE_KEY_SHAPE,
      optionalVisibilityRows: [
        {
          rowKey: "window:day",
          resultType: "quota",
          kind: "percent",
          label: "Daily",
          info: "Chutes daily quota window.",
        },
      ],
    },
  },
  {
    id: "google-gemini-cli",
    label: "Gemini CLI",
    runtimeIds: ["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth", "google"],
    synonyms: ["gemini-cli", "google-gemini", "opencode-gemini-auth", "gemini"],
    shape: {
      recommendedReplacementId: "google-agy",
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "remote_api",
      quickSetupAnchor: "gemini-cli",
    },
  },
  {
    id: "google-agy",
    label: "Google AGY",
    runtimeIds: ["google-agy", "opencode-agy-auth", "google-agy-auth"],
    synonyms: ["opencode-agy-auth", "google-agy-auth"],
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "remote_api",
      quickSetupAnchor: "google-agy-quick-setup",
    },
  },
  {
    id: "zai",
    label: "Z.ai",
    runtimeIds: ["zai", "glm", "zai-coding-plan"],
    synonyms: [],
    shape: GLM_CODING_PLAN_SHAPE,
  },
  {
    id: "zhipu",
    label: "Zhipu",
    runtimeIds: ["zhipu", "glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"],
    synonyms: ["glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"],
    shape: GLM_CODING_PLAN_SHAPE,
  },
  {
    id: "nanogpt",
    label: "NanoGPT",
    runtimeIds: ["nanogpt", "nano-gpt"],
    synonyms: ["nano-gpt"],
    shape: {
      ...SINGLE_SOURCE_KEY_SHAPE,
      optionalVisibilityRows: [
        {
          rowKey: "window:day",
          resultType: "quota",
          kind: "percent",
          label: "Daily",
          info: "NanoGPT daily subscription limit, when the plan reports it.",
        },
        {
          rowKey: "window:month",
          resultType: "quota",
          kind: "percent",
          label: "Monthly",
          info: "NanoGPT monthly subscription limit, when the plan reports it.",
        },
        {
          rowKey: "component:current_balance",
          resultType: "balance",
          kind: "quantity",
          label: "Balance",
          info: "NanoGPT account balance, when the API reports it.",
        },
      ],
    },
  },
  {
    id: "minimax-coding-plan",
    label: "MiniMax Token Plan",
    runtimeIds: ["minimax-coding-plan", "minimax"],
    synonyms: ["minimax"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      autoResume: "account-or-single-source",
    },
  },
  {
    id: "minimax-china-coding-plan",
    label: "MiniMax Token Plan (CN)",
    labelAliases: ["minimax-cn-coding-plan"],
    runtimeIds: [
      "minimax-china-coding-plan",
      "minimax-cn-coding-plan",
      "minimax-cn",
      "minimax-china",
    ],
    synonyms: ["minimax-cn", "minimax-china", "minimax-cn-coding-plan"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      autoResume: "account-or-single-source",
    },
  },
  {
    id: "kimi-code-plan-global",
    label: "Kimi Code",
    runtimeIds: ["kimi-code-plan-global"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "kimi-code-plan-cn",
    label: "Kimi Code (CN)",
    labelAliases: ["kimi-code"],
    runtimeIds: ["kimi-code-plan-cn", "kimi-for-coding", "kimi", "kimi-code"],
    synonyms: ["kimi", "kimi-for-code", "kimi-code", "kimi-for-coding"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    runtimeIds: ["deepseek"],
    synonyms: ["deep-seek"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      optionalVisibilityRows: [
        {
          rowKey: "component:total_balance",
          resultType: "balance",
          kind: "quantity",
          label: "Total balance",
          info: "DeepSeek total account balance, when the API reports it.",
        },
        {
          rowKey: "component:granted_balance",
          resultType: "balance",
          kind: "quantity",
          label: "Granted balance",
          info: "DeepSeek granted balance, when the API reports it.",
        },
        {
          rowKey: "component:topped_up_balance",
          resultType: "balance",
          kind: "quantity",
          label: "Topped-up balance",
          info: "DeepSeek topped-up balance, when the API reports it.",
        },
        {
          rowKey: "named:Availability",
          resultType: "status",
          kind: "boolean",
          label: "Availability",
          info: "DeepSeek account availability, shown only when no balance is reported.",
        },
      ],
    },
  },
  {
    id: "xai",
    label: "xAI",
    runtimeIds: ["xai"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_oauth_token",
      quota: "remote_api",
      autoResume: "account",
      notes: "SuperGrok OAuth via OpenCode /connect; shared weekly credit meter",
    },
  },
  {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    runtimeIds: [
      "xiaomi",
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-sgp",
    ],
    synonyms: ["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"],
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "state_only",
      quota: "remote_api",
      optionalVisibilityRows: [
        {
          rowKey: "window:month",
          resultType: "quota",
          kind: "percent",
          label: "Monthly",
          info: "Xiaomi MiMo monthly plan usage, when the dashboard reports it.",
        },
        {
          rowKey: "component:total_balance",
          resultType: "balance",
          kind: "quantity",
          label: "Total balance",
          info: "Xiaomi MiMo total balance, when the dashboard reports it.",
        },
        {
          rowKey: "component:cash_balance",
          resultType: "balance",
          kind: "quantity",
          label: "Cash balance",
          info: "Xiaomi MiMo cash balance, when the dashboard reports it.",
        },
        {
          rowKey: "component:gift_balance",
          resultType: "balance",
          kind: "quantity",
          label: "Gift balance",
          info: "Xiaomi MiMo gift balance, when the dashboard reports it.",
        },
      ],
      quickSetupAnchor: "xiaomi-mimo",
      notes: "Reads the Xiaomi MiMo dashboard with a filtered trusted cookie",
    },
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    runtimeIds: ["opencode-go"],
    synonyms: ["opencode-go-subscription"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      autoResume: "account",
      optionalVisibilityRows: [
        {
          rowKey: "window:five_hour",
          resultType: "quota",
          kind: "percent",
          label: "5h",
          info: "OpenCode Go rolling 5-hour window.",
        },
        {
          rowKey: "window:week",
          resultType: "quota",
          kind: "percent",
          label: "Weekly",
          info: "OpenCode Go weekly window.",
        },
        {
          rowKey: "window:month",
          resultType: "quota",
          kind: "percent",
          label: "Monthly",
          info: "OpenCode Go monthly window.",
        },
      ],
      notes: "Reads the official OpenCode Go usage API through standard Go API-key sources",
    },
  },
  {
    id: "opencode",
    label: "OpenCode Zen",
    runtimeIds: ["opencode", "opencode-zen"],
    synonyms: ["opencode-zen"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_oauth_token",
      quota: "remote_api",
      autoResume: "account",
      optionalVisibilityRows: [
        {
          rowKey: "window:month",
          resultType: "budget",
          kind: "percent",
          label: "Monthly budget",
          info: "OpenCode Zen monthly budget usage, when a limit is configured or reported.",
        },
        {
          rowKey: "window:month",
          resultType: "spend",
          kind: "quantity",
          label: "Monthly spend",
          info: "OpenCode Zen monthly spend, shown when no budget limit exists.",
        },
        {
          rowKey: "component:current_balance",
          resultType: "balance",
          kind: "quantity",
          label: "Balance",
          info: "OpenCode Zen current account balance.",
        },
        {
          rowKey: "component:auto_reload",
          resultType: "status",
          kind: "boolean",
          label: "Auto-reload",
          info: "OpenCode Zen auto-reload setting, when the console reports it.",
        },
      ],
      notes:
        "Reads the OpenCode Console billing, budget and usage APIs with your OpenCode Console sign-in",
    },
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    runtimeIds: ["ollama-cloud"],
    synonyms: [],
    shape: {
      ...SINGLE_SOURCE_KEY_SHAPE,
      optionalVisibilityRows: [
        {
          rowKey: "named:Session",
          resultType: "quota",
          kind: "percent",
          label: "Session",
          info: "Ollama Cloud legacy session limit; its fixed reset window is not documented.",
        },
        {
          rowKey: "window:week",
          resultType: "quota",
          kind: "percent",
          label: "Weekly",
          info: "Ollama Cloud legacy weekly limit.",
        },
        {
          rowKey: "window:month",
          resultType: "quota",
          kind: "percent",
          label: "Monthly",
          info: "Ollama Cloud included credits remaining in the current plan period.",
        },
        {
          rowKey: "component:remaining_credits",
          resultType: "balance",
          label: "Purchased",
          info: "Ollama Cloud purchased credits, when any remain.",
        },
      ],
      notes:
        "Queries the Ollama Cloud balance API; reports included credits or session and weekly limits, plus purchased credits",
    },
  },
  {
    id: "quota-providers",
    label: "Quota providers",
    runtimeIds: [],
    synonyms: [],
    shape: {
      autoSetup: "manual_env_config",
      authentication: "external_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      notes: "Aggregates exact user-configured accounting sources",
    },
  },
] as const satisfies readonly QuotaProviderRegistrationSourceEntry[];

export type CanonicalQuotaProviderId = (typeof QUOTA_PROVIDER_REGISTRATION_SOURCE)[number]["id"];
