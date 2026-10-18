import { resolve } from "path";
import { hasAnthropicCredentialsConfigured } from "./anthropic.js";
import { buildCliShowJson, buildCliShowText, type CliReport } from "./cli-reports.js";
import { findGitWorktreeRoot } from "./config-file-utils.js";
import {
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
  resolveKimiCnAuthCached,
  resolveKimiGlobalAuthCached,
} from "./kimi-auth.js";
import { bindCredentialSource } from "./opencode-auth.js";
import { createSqliteCredentialSource } from "./opencode-auth-sqlite.js";
import {
  loadConfiguredOpenCodeConfig,
  loadConfiguredProviderIds,
} from "./opencode-config-providers.js";
import { getQuotaProviderShape } from "./provider-metadata.js";
import type { QuotaRuntimeClient, QuotaRuntimeContext } from "./quota-runtime-context.js";
import { resolveQuotaRuntimeContext } from "./quota-runtime-context.js";
import type { QuotaToastConfig } from "./types.js";

export interface RunCliShowCommandOptions {
  argv?: string[];
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

type ParsedShowArgs =
  | { ok: true; providerId?: string; help: boolean; json: boolean; threshold?: number }
  | { ok: false; error: string };

const SHOW_USAGE = [
  "Usage:",
  "  npx opencode-quota-gui show [--provider <provider-id>] [--json] [--threshold <pct>]",
  "",
  "Options:",
  "  --provider <provider-id>  Show quota for one provider",
  "  --json                    Machine-readable JSON output (reads from cache)",
  "  --threshold <pct>         With --json, exit 1 if any complete cached percentage is below",
  "                            <pct>% remaining (exit 2 if data is incomplete or not comparable)",
  "  --help, -h                Show help",
].join("\n");

function parseShowArgs(argv: string[]): ParsedShowArgs {
  let providerId: string | undefined;
  let json = false;
  let threshold: number | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      return { ok: true, help: true, json: false };
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--threshold" || arg.startsWith("--threshold=")) {
      let value: string | undefined;
      if (arg === "--threshold") {
        value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          return { ok: false, error: "Missing value for --threshold." };
        }
        index += 1;
      } else {
        value = arg.slice("--threshold=".length).trim();
        if (!value) {
          return { ok: false, error: "Missing value for --threshold." };
        }
      }
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        return { ok: false, error: "--threshold must be a positive finite number." };
      }
      threshold = num;
      continue;
    }

    if (arg === "--provider") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        return { ok: false, error: "Missing value for --provider." };
      }
      if (providerId) {
        return { ok: false, error: "Specify --provider only once." };
      }
      providerId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length).trim();
      if (!value) {
        return { ok: false, error: "Missing value for --provider." };
      }
      if (providerId) {
        return { ok: false, error: "Specify --provider only once." };
      }
      providerId = value;
      continue;
    }

    if (arg.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${arg}` };
    }

    return { ok: false, error: `Unexpected argument: ${arg}` };
  }

  if (threshold !== undefined && !json) {
    return { ok: false, error: "--threshold requires --json." };
  }

  return { ok: true, providerId, help: false, json, threshold };
}

export function resolveCliRoots(cwd: string): {
  workspaceRoot: string;
  configRoot: string;
  fallbackDirectory: string;
} {
  const fallbackDirectory = resolve(cwd);
  const worktreeRoot = findGitWorktreeRoot(fallbackDirectory) ?? fallbackDirectory;
  return {
    workspaceRoot: worktreeRoot,
    configRoot: worktreeRoot,
    fallbackDirectory,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function loadCliAuthenticatedProviderIds(config: Record<string, unknown>): Promise<string[]> {
  const experimental = isRecord(config.experimental) ? config.experimental : undefined;
  const quotaToast = isRecord(experimental?.quotaToast) ? experimental.quotaToast : undefined;
  const anthropicBinaryPath =
    typeof quotaToast?.anthropicBinaryPath === "string"
      ? quotaToast.anthropicBinaryPath
      : undefined;
  const [anthropicConfigured, kimiGlobalAuth, kimiCnAuth] = await Promise.all([
    hasAnthropicCredentialsConfigured({ binaryPath: anthropicBinaryPath }),
    resolveKimiGlobalAuthCached({ maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS }),
    resolveKimiCnAuthCached({ maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS }),
  ]);

  return [
    ...(anthropicConfigured ? ["anthropic"] : []),
    ...(kimiGlobalAuth.state === "configured" ? ["kimi-code-plan-global"] : []),
    ...(kimiCnAuth.state === "configured" ? ["kimi-code-plan-cn"] : []),
  ];
}

export function createCliQuotaClient(params: { configRootDir: string }): QuotaRuntimeClient {
  let configPromise: Promise<Record<string, unknown>> | undefined;
  let providerIdsPromise: Promise<string[]> | undefined;

  return {
    config: {
      get: async () => {
        configPromise ??= loadConfiguredOpenCodeConfig({
          configRootDir: params.configRootDir,
        });
        return {
          data: (await configPromise) as {
            experimental?: { quotaToast?: Partial<QuotaToastConfig> };
            model?: string;
          },
        };
      },
      providers: async () => {
        providerIdsPromise ??= (async () => {
          configPromise ??= loadConfiguredOpenCodeConfig({
            configRootDir: params.configRootDir,
          });
          const [configuredIds, authenticatedIds] = await Promise.all([
            loadConfiguredProviderIds({ configRootDir: params.configRootDir }),
            configPromise.then(loadCliAuthenticatedProviderIds),
          ]);
          return [...new Set([...configuredIds, ...authenticatedIds])];
        })();
        const ids = await providerIdsPromise;
        return {
          data: {
            providers: ids.map((id) => ({ id })),
          },
        };
      },
    },
  };
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(message.endsWith("\n") ? message : `${message}\n`);
}

/**
 * Builds one `show` or `status` report in this process, for the folder the command runs in,
 * and prints it. It works with OpenCode closed: logins are read read-only from OpenCode's
 * database, and only while the report runs.
 */
export async function runCliReport(params: {
  cwd: string;
  failurePrefix: "Failed to show quota" | "Failed to generate quota status";
  build: (runtime: QuotaRuntimeContext) => Promise<CliReport>;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}): Promise<number> {
  const unbind = bindCredentialSource(createSqliteCredentialSource());
  try {
    const roots = resolveCliRoots(params.cwd);
    const runtime = await resolveQuotaRuntimeContext({
      client: createCliQuotaClient({ configRootDir: roots.configRoot }),
      roots,
      includeSessionMeta: false,
    });
    const report = await params.build(runtime);
    params.stdout.write(report.stdout);
    params.stderr.write(report.stderr);
    return report.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(params.stderr, `${params.failurePrefix}: ${message}`);
    return 1;
  } finally {
    unbind();
  }
}

export async function runCliShowCommand(options: RunCliShowCommandOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(3);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseShowArgs(argv);
  if (!parsed.ok) {
    writeLine(stderr, parsed.error);
    writeLine(stderr, SHOW_USAGE);
    return 1;
  }

  if (parsed.help) {
    writeLine(stdout, SHOW_USAGE);
    return 0;
  }

  const providerId = parsed.providerId ? getQuotaProviderShape(parsed.providerId)?.id : undefined;
  if (parsed.providerId && !providerId) {
    writeLine(stderr, `Unknown provider: ${parsed.providerId}`);
    return 1;
  }

  return runCliReport({
    cwd: options.cwd ?? process.cwd(),
    failurePrefix: "Failed to show quota",
    build: (runtime) =>
      parsed.json
        ? buildCliShowJson({ runtime, providerId, threshold: parsed.threshold })
        : buildCliShowText({ runtime, providerId }),
    stdout,
    stderr,
  });
}
