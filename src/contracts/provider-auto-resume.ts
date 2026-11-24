/**
 * Providers that can supply auto-resume evidence, in provider-registration
 * order. Settings help copy is browser-layer code and must not import the
 * provider metadata module, so the labels are mirrored here for that one
 * string. `tests/lib.provider-metadata.test.ts` fails if this list drifts from
 * the registration metadata's `autoResume` bindings.
 */
export const AUTO_RESUME_SUPPORTED_PROVIDER_LABELS = [
  "Claude Agent",
  "Copilot",
  "OpenAI",
  "Synthetic",
  "Chutes",
  "Z.ai",
  "Zhipu",
  "NanoGPT",
  "MiniMax Token Plan",
  "MiniMax Token Plan (CN)",
  "xAI",
  "OpenCode Go",
  "OpenCode Zen",
  "Ollama Cloud",
] as const;
