import { describe, expect, it } from "vitest";
import { AUTO_RESUME_SUPPORTED_PROVIDER_LABELS } from "../src/contracts/provider-auto-resume.js";
import { normalizeEnabledProviders } from "../src/lib/config.js";
import {
  getQuotaProviderDisplayLabel,
  getQuotaProviderIdsForRuntimeId,
  getQuotaProviderRegistration,
  getQuotaProviderRuntimeIds,
  getSupportedAutoResumeProviderLabels,
  normalizeQuotaProviderId,
  QUOTA_PROVIDER_CATALOG,
  QUOTA_PROVIDER_ID_SYNONYMS,
  QUOTA_PROVIDER_LABELS,
  QUOTA_PROVIDER_RUNTIME_IDS,
  QUOTA_PROVIDER_SHAPES,
} from "../src/lib/provider-metadata.js";
import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";

describe("provider-metadata", () => {
  it("defines the canonical provider setup catalog", () => {
    expect(QUOTA_PROVIDER_SHAPES).toMatchObject([
      {
        id: "anthropic",
        autoSetup: "usually",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
        notes:
          "Passive per-minute rate-limit headers from real API-key requests; no spend or balance",
      },
      {
        id: "claude-agent",
        autoSetup: "needs_quick_setup",
        authentication: "local_cli_auth",
        quota: "local_cli_report",
        quickSetupAnchor: "claude-agent",
      },
      {
        id: "copilot",
        autoSetup: "usually",
        authentication: "github_oauth_or_pat",
        quota: "remote_api",
        notes: "OAuth for personal flow; PAT for managed billing",
      },
      {
        id: "openai",
        autoSetup: "yes",
        authentication: "opencode_auth_oauth_token",
        quota: "remote_api",
      },
      {
        id: "openrouter",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "kilo",
        autoSetup: "usually",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
        notes:
          "Queries Kilo Pass state first, then falls back to the documented personal Gateway balance when no active subscription exists",
      },
      {
        id: "cursor",
        autoSetup: "needs_quick_setup",
        authentication: "companion_auth_oauth_token",
        quota: "local_runtime_accounting",
        quickSetupAnchor: "cursor",
        notes: "companion runtime/plugin integration plus local usage accounting",
      },
      {
        id: "alibaba-coding-plan",
        autoSetup: "needs_quick_setup",
        authentication: "local_cli_auth",
        quota: "local_cli_report",
        quickSetupAnchor: "alibaba-coding-plan",
      },
      {
        id: "alibaba-token-plan",
        autoSetup: "needs_quick_setup",
        authentication: "local_cli_auth",
        quota: "local_cli_report",
        quickSetupAnchor: "alibaba-personal-token-plan",
      },
      {
        id: "synthetic",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "chutes",
        autoSetup: "usually",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "google-gemini-cli",
        recommendedReplacementId: "google-agy",
        autoSetup: "needs_quick_setup",
        authentication: "companion_auth_oauth_token",
        quota: "remote_api",
        quickSetupAnchor: "gemini-cli",
      },
      {
        id: "google-agy",
        autoSetup: "needs_quick_setup",
        authentication: "companion_auth_oauth_token",
        quota: "remote_api",
        quickSetupAnchor: "google-agy-quick-setup",
      },
      {
        id: "zai",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "zhipu",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "nanogpt",
        autoSetup: "usually",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "minimax-coding-plan",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "minimax-china-coding-plan",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "kimi-code-plan-global",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "kimi-code-plan-cn",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "deepseek",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "mistral",
        autoSetup: "usually",
        authentication: "external_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
        notes:
          "Reads the Mistral Vibe billing budget with MISTRAL_API_KEY from the environment, <VIBE_HOME>/.env or an OpenCode Mistral login",
      },
      {
        id: "xai",
        autoSetup: "yes",
        authentication: "opencode_auth_oauth_token",
        quota: "remote_api",
        notes: "SuperGrok OAuth via OpenCode /connect; shared weekly credit meter",
      },
      {
        id: "xiaomi",
        autoSetup: "needs_quick_setup",
        authentication: "state_only",
        quota: "remote_api",
        quickSetupAnchor: "xiaomi-mimo",
        notes: "Reads the Xiaomi MiMo dashboard with a filtered trusted cookie",
      },
      {
        id: "opencode-go",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
        notes: "Reads the official OpenCode Go usage API through standard Go API-key sources",
      },
      {
        id: "opencode",
        autoSetup: "yes",
        authentication: "opencode_auth_oauth_token",
        quota: "remote_api",
        notes:
          "Reads the OpenCode Console billing, budget and usage APIs with your OpenCode Console sign-in",
      },
      {
        id: "ollama-cloud",
        autoSetup: "usually",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
        notes:
          "Queries the Ollama Cloud balance API; reports included credits or session and weekly limits, plus purchased credits",
      },
      {
        id: "quota-providers",
        autoSetup: "manual_env_config",
        authentication: "external_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
        notes: "Aggregates exact user-configured accounting sources",
      },
    ]);
  });

  it("derives public metadata views from the ordered registration source", () => {
    const registrationIds = QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id);
    expect(Object.keys(QUOTA_PROVIDER_CATALOG)).toEqual(registrationIds);
    expect(QUOTA_PROVIDER_SHAPES.map((shape) => shape.id)).toEqual(registrationIds);
    for (const [id, entry] of Object.entries(QUOTA_PROVIDER_CATALOG)) {
      expect(entry.shape.id).toBe(id);
      expect(QUOTA_PROVIDER_LABELS[id]).toBe(entry.label);
      expect(QUOTA_PROVIDER_SHAPES.find((shape) => shape.id === id)).toBe(entry.shape);
      expect(QUOTA_PROVIDER_RUNTIME_IDS[id as keyof typeof QUOTA_PROVIDER_RUNTIME_IDS]).toEqual(
        entry.runtimeIds,
      );
      for (const synonym of entry.synonyms) {
        expect(QUOTA_PROVIDER_ID_SYNONYMS[synonym]).toBe(id);
      }
    }
  });

  it("preserves direct label aliases from the authored catalog", () => {
    expect(QUOTA_PROVIDER_LABELS["minimax-cn-coding-plan"]).toBe("MiniMax Token Plan (CN)");
    expect(QUOTA_PROVIDER_LABELS["kimi-code"]).toBe("Kimi Code (CN)");
    expect(QUOTA_PROVIDER_CATALOG["minimax-china-coding-plan"].labelAliases).toContain(
      "minimax-cn-coding-plan",
    );
    expect(QUOTA_PROVIDER_CATALOG["kimi-code-plan-cn"].labelAliases).toContain("kimi-code");
  });

  it("keeps canonical provider setup ids unique", () => {
    const ids = QUOTA_PROVIDER_SHAPES.map((shape) => shape.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("normalizes provider synonyms to canonical ids", () => {
    expect(normalizeQuotaProviderId("claude")).toBe("claude-agent");
    expect(normalizeQuotaProviderId("anthropic")).toBe("anthropic");
    expect(normalizeEnabledProviders(["claude", "claude-code", "anthropic"])).toEqual({
      value: ["claude-agent", "anthropic"],
      issues: [],
      invalidEmpty: false,
    });
    expect(normalizeQuotaProviderId("  openai  ")).toBe("openai");

    for (const [alias, canonicalId] of Object.entries(QUOTA_PROVIDER_ID_SYNONYMS)) {
      expect(normalizeQuotaProviderId(alias)).toBe(canonicalId);
    }
  });

  it("defines conservative runtime ids for provider matching", () => {
    expect(QUOTA_PROVIDER_RUNTIME_IDS.copilot).toEqual([
      "copilot",
      "github-copilot",
      "copilot-chat",
      "github-copilot-chat",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.anthropic).toEqual(["anthropic"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["claude-agent"]).toEqual(["claude-agent", "claude-code"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.openai).toEqual(["openai", "chatgpt", "codex"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.kilo).toEqual(["kilo"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.cursor).toEqual(["cursor", "cursor-acp"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.synthetic).toEqual(["synthetic"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.chutes).toEqual(["chutes", "chutes-ai"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["google-gemini-cli"]).toEqual([
      "google-gemini-cli",
      "gemini-cli",
      "gemini",
      "opencode-gemini-auth",
      "google",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["google-agy"]).toEqual([
      "google-agy",
      "opencode-agy-auth",
      "google-agy-auth",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.zai).toEqual(["zai", "glm", "zai-coding-plan"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.zhipu).toEqual([
      "zhipu",
      "glm-coding-plan",
      "zhipu-coding-plan",
      "zhipuai-coding-plan",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.nanogpt).toEqual(["nanogpt", "nano-gpt"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["minimax-coding-plan"]).toEqual([
      "minimax-coding-plan",
      "minimax",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["minimax-china-coding-plan"]).toEqual([
      "minimax-china-coding-plan",
      "minimax-cn-coding-plan",
      "minimax-cn",
      "minimax-china",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["kimi-code-plan-global"]).toEqual(["kimi-code-plan-global"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["kimi-code-plan-cn"]).toEqual([
      "kimi-code-plan-cn",
      "kimi-for-coding",
      "kimi",
      "kimi-code",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.deepseek).toEqual(["deepseek"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.opencode).toEqual(["opencode", "opencode-zen"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.xai).toEqual(["xai"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.xiaomi).toEqual([
      "xiaomi",
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-sgp",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["quota-providers"]).toEqual([]);
  });

  it("keeps runtime ids distinct from broad normalization aliases", () => {
    expect(getQuotaProviderRuntimeIds("github-copilot")).toEqual([
      "copilot",
      "github-copilot",
      "copilot-chat",
      "github-copilot-chat",
    ]);
    expect(getQuotaProviderRuntimeIds("claude")).toEqual(["claude-agent", "claude-code"]);
    expect(getQuotaProviderRuntimeIds("claude-code")).toEqual(["claude-agent", "claude-code"]);
    expect(getQuotaProviderRuntimeIds("openai")).toEqual(["openai", "chatgpt", "codex"]);
    expect(getQuotaProviderRuntimeIds("kilo")).toEqual(["kilo"]);
    expect(getQuotaProviderRuntimeIds("kilo-gateway")).toEqual([]);
    expect(getQuotaProviderRuntimeIds("open-cursor")).toEqual(["cursor", "cursor-acp"]);
    expect(getQuotaProviderRuntimeIds("google-antigravity")).toEqual([]);
    expect(getQuotaProviderRuntimeIds("gemini-cli")).toEqual([
      "google-gemini-cli",
      "gemini-cli",
      "gemini",
      "opencode-gemini-auth",
      "google",
    ]);
    expect(getQuotaProviderRuntimeIds("google-agy")).toEqual([
      "google-agy",
      "opencode-agy-auth",
      "google-agy-auth",
    ]);
    expect(getQuotaProviderRuntimeIds("zai")).toEqual(["zai", "glm", "zai-coding-plan"]);
    expect(getQuotaProviderRuntimeIds("zhipu-coding-plan")).toEqual([
      "zhipu",
      "glm-coding-plan",
      "zhipu-coding-plan",
      "zhipuai-coding-plan",
    ]);
    expect(getQuotaProviderRuntimeIds("glm-coding-plan")).toEqual([
      "zhipu",
      "glm-coding-plan",
      "zhipu-coding-plan",
      "zhipuai-coding-plan",
    ]);
    expect(getQuotaProviderRuntimeIds("minimax")).toEqual(["minimax-coding-plan", "minimax"]);
    expect(getQuotaProviderRuntimeIds("minimax-cn")).toEqual([
      "minimax-china-coding-plan",
      "minimax-cn-coding-plan",
      "minimax-cn",
      "minimax-china",
    ]);
    expect(getQuotaProviderRuntimeIds("kimi-code-plan-global")).toEqual(["kimi-code-plan-global"]);
    expect(getQuotaProviderRuntimeIds("kimi")).toEqual([
      "kimi-code-plan-cn",
      "kimi-for-coding",
      "kimi",
      "kimi-code",
    ]);
    expect(getQuotaProviderIdsForRuntimeId("kimi-code-plan-global")).toEqual([
      "kimi-code-plan-global",
    ]);
    expect(getQuotaProviderIdsForRuntimeId("kimi-code-plan-cn")).toEqual(["kimi-code-plan-cn"]);
    expect(getQuotaProviderIdsForRuntimeId("kimi")).toEqual(["kimi-code-plan-cn"]);
    expect(getQuotaProviderRuntimeIds("deep-seek")).toEqual(["deepseek"]);
    expect(getQuotaProviderRuntimeIds("opencode-zen")).toEqual(["opencode", "opencode-zen"]);
    expect(getQuotaProviderRuntimeIds("xai")).toEqual(["xai"]);
    expect(getQuotaProviderRuntimeIds("xiaomi-token-plan-cn")).toEqual([
      "xiaomi",
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-sgp",
    ]);
    expect(getQuotaProviderRuntimeIds("mimo")).toEqual([]);
    expect(getQuotaProviderRuntimeIds("xiaomi-mimo")).toEqual([]);
    expect(getQuotaProviderRuntimeIds("grok")).toEqual([]);
    expect(getQuotaProviderRuntimeIds("not-a-provider")).toEqual([]);
  });

  it("returns provider setup metadata for canonical ids and aliases", () => {
    expect(getQuotaProviderRegistration("openai")).toMatchObject({
      id: "openai",
      autoSetup: "yes",
      authentication: "opencode_auth_oauth_token",
      quota: "remote_api",
    });
    expect(getQuotaProviderRegistration("github-copilot")).toMatchObject({
      id: "copilot",
      autoSetup: "usually",
      authentication: "github_oauth_or_pat",
      quota: "remote_api",
      notes: "OAuth for personal flow; PAT for managed billing",
    });
    expect(getQuotaProviderRegistration("alibaba")).toMatchObject({
      id: "alibaba-coding-plan",
      autoSetup: "needs_quick_setup",
      authentication: "local_cli_auth",
      quota: "local_cli_report",
      quickSetupAnchor: "alibaba-coding-plan",
    });
    expect(getQuotaProviderRegistration("alibaba-token-plan")).toMatchObject({
      id: "alibaba-token-plan",
      autoSetup: "needs_quick_setup",
      authentication: "local_cli_auth",
      quota: "local_cli_report",
      quickSetupAnchor: "alibaba-personal-token-plan",
    });
    expect(getQuotaProviderRegistration("alibaba-coding-plan")).not.toEqual(
      getQuotaProviderRegistration("alibaba-token-plan"),
    );
    expect(getQuotaProviderRegistration("gemini-cli")).toMatchObject({
      id: "google-gemini-cli",
      recommendedReplacementId: "google-agy",
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "remote_api",
      quickSetupAnchor: "gemini-cli",
    });
    expect(getQuotaProviderRegistration("google-agy")).toMatchObject({
      id: "google-agy",
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "remote_api",
      quickSetupAnchor: "google-agy-quick-setup",
    });
    expect(getQuotaProviderRegistration("deep-seek")).toMatchObject({
      id: "deepseek",
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    });
    expect(getQuotaProviderRegistration("opencode-zen")).toMatchObject({
      id: "opencode",
      autoSetup: "yes",
      authentication: "opencode_auth_oauth_token",
      quota: "remote_api",
      notes:
        "Reads the OpenCode Console billing, budget and usage APIs with your OpenCode Console sign-in",
    });
    expect(getQuotaProviderRegistration("kilo")).toMatchObject({
      id: "kilo",
      autoSetup: "usually",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      notes:
        "Queries Kilo Pass state first, then falls back to the documented personal Gateway balance when no active subscription exists",
    });
    expect(getQuotaProviderRegistration("xai")).toMatchObject({
      id: "xai",
      autoSetup: "yes",
      authentication: "opencode_auth_oauth_token",
      quota: "remote_api",
      notes: "SuperGrok OAuth via OpenCode /connect; shared weekly credit meter",
    });
    expect(getQuotaProviderRegistration("xiaomi-token-plan-ams")).toMatchObject({
      id: "xiaomi",
      autoSetup: "needs_quick_setup",
      authentication: "state_only",
      quota: "remote_api",
      quickSetupAnchor: "xiaomi-mimo",
      notes: "Reads the Xiaomi MiMo dashboard with a filtered trusted cookie",
    });
    expect(getQuotaProviderRegistration("not-a-provider")).toBeUndefined();
    expect(getQuotaProviderRegistration("qwen-code")).toBeUndefined();
    expect(getQuotaProviderRegistration("google-antigravity")).toBeUndefined();
  });

  it("declares persistent visibility rows for optional fields", () => {
    const optionalRows = (id: string) =>
      getQuotaProviderRegistration(id)?.optionalVisibilityRows ?? [];
    const keys = (id: string) =>
      optionalRows(id).map((row) => `${row.rowKey}|${row.resultType}|${row.kind ?? "value"}`);

    expect(keys("openai")).toEqual(
      expect.arrayContaining([
        "window:five_hour|rate_limit|percent",
        "window:week|rate_limit|percent",
        "window:month|rate_limit|percent",
        "window:code_review|rate_limit|percent",
        "openai:resets|status|value",
        "openai:credits|balance|value",
      ]),
    );
    expect(keys("claude-agent")).toEqual(
      expect.arrayContaining([
        "window:five_hour|quota|percent",
        "window:week|quota|percent",
        "window:month|quota|percent",
        "named:Fable weekly|quota|percent",
        "claude-agent:resets|status|value",
      ]),
    );
    expect(keys("opencode")).toEqual(
      expect.arrayContaining([
        "window:month|budget|percent",
        "window:month|spend|quantity",
        "component:current_balance|balance|quantity",
        "component:auto_reload|status|boolean",
      ]),
    );
    expect(keys("deepseek")).toEqual(
      expect.arrayContaining([
        "component:total_balance|balance|quantity",
        "component:granted_balance|balance|quantity",
        "component:topped_up_balance|balance|quantity",
        "named:Availability|status|boolean",
      ]),
    );
    expect(keys("copilot")).toEqual(
      expect.arrayContaining([
        "window:month|quota|percent",
        "named:additional_usage|budget|percent",
      ]),
    );
    expect(keys("anthropic")).toEqual(
      expect.arrayContaining([
        "rate_limit:requests|rate_limit|value",
        "rate_limit:tokens|rate_limit|value",
        "rate_limit:inputTokens|rate_limit|value",
        "rate_limit:outputTokens|rate_limit|value",
      ]),
    );

    const seen = new Map<string, Set<string>>();
    for (const shape of QUOTA_PROVIDER_SHAPES) {
      const ids = new Set<string>();
      for (const row of shape.optionalVisibilityRows ?? []) {
        expect(row.rowKey.trim()).not.toBe("");
        expect(row.label.trim()).not.toBe("");
        expect(row.info.trim()).not.toBe("");
        const id = `${row.rowKey}|${row.resultType}|${row.kind ?? "value"}`;
        expect(ids.has(id), `${shape.id} declares ${id} twice`).toBe(false);
        ids.add(id);
      }
      seen.set(shape.id, ids);
    }
    expect(seen.size).toBe(QUOTA_PROVIDER_SHAPES.length);
  });

  it("returns display labels for known providers", () => {
    expect(getQuotaProviderDisplayLabel("anthropic")).toBe("Anthropic");
    expect(getQuotaProviderDisplayLabel("gemini-cli")).toBe("Gemini CLI");
    expect(getQuotaProviderDisplayLabel("google-agy")).toBe("Google AGY");
    expect(getQuotaProviderDisplayLabel("cursor")).toBe("Cursor");
    expect(getQuotaProviderDisplayLabel("alibaba-coding-plan")).toBe("Alibaba Coding Plan");
    expect(getQuotaProviderDisplayLabel("alibaba-token-plan")).toBe("Alibaba Personal Token Plan");
    expect(getQuotaProviderDisplayLabel("synthetic")).toBe("Synthetic");
    expect(getQuotaProviderDisplayLabel("zai")).toBe("Z.ai");
    expect(getQuotaProviderDisplayLabel("zhipu")).toBe("Zhipu");
    expect(getQuotaProviderDisplayLabel("zhipu-coding-plan")).toBe("Zhipu");
    expect(getQuotaProviderDisplayLabel("nanogpt")).toBe("NanoGPT");
    expect(getQuotaProviderDisplayLabel("nano-gpt")).toBe("NanoGPT");
    expect(getQuotaProviderDisplayLabel("minimax")).toBe("MiniMax Token Plan");
    expect(getQuotaProviderDisplayLabel("minimax-cn-coding-plan")).toBe("MiniMax Token Plan (CN)");
    expect(getQuotaProviderDisplayLabel("kimi-code-plan-global")).toBe("Kimi Code");
    expect(getQuotaProviderDisplayLabel("kimi-code")).toBe("Kimi Code (CN)");
    expect(getQuotaProviderDisplayLabel("kimi")).toBe("Kimi Code (CN)");
    expect(getQuotaProviderDisplayLabel("deep-seek")).toBe("DeepSeek");
    expect(getQuotaProviderDisplayLabel("opencode-zen")).toBe("OpenCode Zen");
    expect(getQuotaProviderDisplayLabel("kilo")).toBe("Kilo Gateway");
    expect(getQuotaProviderDisplayLabel("xai")).toBe("xAI");
    expect(getQuotaProviderDisplayLabel("xiaomi")).toBe("Xiaomi MiMo");
    expect(getQuotaProviderDisplayLabel("xiaomi-token-plan-sgp")).toBe("Xiaomi MiMo");
    expect(getQuotaProviderDisplayLabel("mimo")).toBe("mimo");
    expect(getQuotaProviderDisplayLabel("grok")).toBe("grok");
    expect(getQuotaProviderDisplayLabel("quota-providers")).toBe("Quota providers");
    expect(getQuotaProviderDisplayLabel("something-else")).toBe("something-else");
  });

  it("keeps the browser-safe auto-resume label list aligned with registration metadata", () => {
    expect([...AUTO_RESUME_SUPPORTED_PROVIDER_LABELS]).toEqual([
      ...getSupportedAutoResumeProviderLabels(),
    ]);
  });
});
