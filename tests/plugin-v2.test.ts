import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messageDocument } from "../src/lib/report-document.js";

const buildOutput = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>()),
  buildQuotaDialogCommandOutput: buildOutput,
}));
const resolveRetryDelay = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-retry-wait.js", () => ({
  resolveQuotaResetRetryDelayMs: resolveRetryDelay,
}));

// Keep the plugin's runtime dirs synthetic: the dashboard setup reads the global
// config dir, and no test may touch the user's real config or data.
const TEST_RUNTIME_ROOT = vi.hoisted(() => "/tmp/opencode-quota-plugin-v2-tests");
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

import {
  clearReadAuthFileCacheForTests,
  getCredentialSourceDiagnostics,
  readAuthFile,
  readAuthFileCached,
} from "../src/lib/opencode-auth.js";
import { QUOTA_DIALOG_COMMANDS } from "../src/lib/quota-dialog-command-specs.js";
import { formatQuotaReportMessage } from "../src/lib/quota-report-message.js";
import plugin from "../src/plugin.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";

type RegisteredTool = {
  name: string;
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
};
type RegisteredCommand = {
  name: string;
  description?: string;
  execute: (invocation: {
    sessionID: string;
    prompt: { text: string };
    delivery: "steer" | "queue";
  }) => Promise<void>;
};
type Part = { type: string; text?: string };
type Message = { role: string; metadata?: Record<string, unknown>; content: Part[] };
type HookEvent = { messages: Message[]; result?: string };
type RetryEvent = {
  sessionID: string;
  agent: string;
  model: { id: string; providerID: string };
  error: { type: string; message: string; status?: number };
  attempt: number;
  decision: { retry: false } | { retry: true; delay: number };
};

function createContext() {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const hooks = new Map<string, (event: HookEvent) => void>();
  const calls: string[] = [];
  const ctx = {
    location: { directory: "/tmp/opencode/quota-plugin-v2" },
    provider: { list: vi.fn().mockResolvedValue({ data: [{ id: "openai" }] }) },
    session: {
      get: vi.fn().mockResolvedValue({ model: { id: "gpt-5", providerID: "openai" } }),
      wait: vi.fn(async () => {
        calls.push("wait");
      }),
      prompt: vi.fn(async () => {
        calls.push("prompt");
        return {};
      }),
      hook: vi.fn(async (name: string, callback: (event: HookEvent) => void) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      }),
    },
    tool: {
      transform: vi.fn(async (callback) => {
        callback({ add: (tool: RegisteredTool) => tools.push(tool) });
      }),
    },
    command: {
      transform: vi.fn(async (callback) => {
        callback({ add: (command: RegisteredCommand) => commands.push(command) });
      }),
    },
    rpc: { register: vi.fn(async () => ({ dispose: async () => {}, events: { emit: vi.fn() } })) },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  };
  return { ctx, tools, commands, hooks, calls };
}

function findCommand(commands: RegisteredCommand[], name: string): RegisteredCommand {
  const found = commands.find((item) => item.name === name);
  if (!found) throw new Error(`Command not registered: ${name}`);
  return found;
}

function runCommand(commands: RegisteredCommand[], name: string, text = "") {
  return findCommand(commands, name).execute({
    sessionID: "session-web",
    prompt: { text },
    delivery: "queue",
  });
}

function hook(hooks: Map<string, (event: HookEvent) => void>, name: string) {
  const found = hooks.get(name);
  if (!found) throw new Error(`Hook not registered: ${name}`);
  return found;
}

const user = (text: string, metadata?: Record<string, unknown>): Message => ({
  role: "user",
  ...(metadata ? { metadata } : {}),
  content: [{ type: "text", text }],
});

/**
 * Tracks every setup so a test that never disposes still releases the plugin's
 * dashboard lease (and its real listener) before the next test runs.
 */
const cleanups: Array<() => Promise<void> | void> = [];

async function setupPlugin(context: unknown): Promise<() => Promise<void> | void> {
  const cleanup = await plugin.setup(context as never);
  const tracked = async () => {
    await cleanup?.();
  };
  cleanups.push(tracked);
  return tracked;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe("V2 server plugin", () => {
  beforeEach(() => {
    buildOutput.mockReset();
    resolveRetryDelay.mockReset();
  });

  it("registers a structured quota diagnostics tool without a server toast dependency", async () => {
    const { ctx, tools } = createContext();
    buildOutput.mockResolvedValue({ state: "output", output: "Quota ready" });

    await setupPlugin(ctx);
    expect(tools.map((tool) => tool.name)).toEqual(["quota_status"]);
    const output = await tools[0].execute({}, { sessionID: "session-test" });
    expect(output).toEqual({ content: "Quota ready" });
    expect(buildOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota_status",
        sessionID: "session-test",
      }),
    );
    expect(ctx.provider.list).toHaveBeenCalledTimes(0);
  });

  it("registers the same slash commands as the TUI", async () => {
    const { ctx, commands } = createContext();

    await setupPlugin(ctx);
    expect(commands.map((item) => ({ name: item.name, description: item.description }))).toEqual(
      QUOTA_DIALOG_COMMANDS.map((spec) => ({
        name: spec.slashName,
        description: spec.description,
      })),
    );
  });

  it("posts the report as a user message that never starts a model turn", async () => {
    const { ctx, commands, calls } = createContext();
    const document = messageDocument("# Quota\nopenai 42%\u001b[31m");
    buildOutput.mockResolvedValue({
      state: "output",
      title: "OpenCode Quota",
      output: "# Quota\nopenai 42%\u001b[31m",
      document,
    });
    vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);

    await setupPlugin(ctx);
    await runCommand(commands, "quota");

    expect(buildOutput).toHaveBeenCalledWith(
      expect.objectContaining({ command: "quota", sessionID: "session-web", arguments: undefined }),
    );
    expect(ctx.session.wait).toHaveBeenCalledWith({ sessionID: "session-web" });
    expect(calls).toEqual(["wait", "prompt"]);
    expect(ctx.session.prompt).toHaveBeenCalledTimes(1);
    expect(ctx.session.prompt.mock.calls[0][0]).toEqual({
      sessionID: "session-web",
      text: formatQuotaReportMessage("# Quota\nopenai 42%"),
      // The TUI sanitizes the document when it draws it.
      metadata: {
        opencodeQuota: {
          command: "quota",
          title: "OpenCode Quota",
          at: 1_790_000_000_000,
          document,
        },
      },
      delivery: "steer",
      resume: false,
    });
    vi.mocked(Date.now).mockRestore();
  });

  it("passes typed arguments to the output builder", async () => {
    const { ctx, commands } = createContext();
    buildOutput.mockResolvedValue({ state: "output", title: "Tokens", output: "report" });

    await setupPlugin(ctx);
    await runCommand(commands, "tokens_between", " 2026-09-01 2026-09-25 ");

    expect(buildOutput).toHaveBeenCalledWith(
      expect.objectContaining({ command: "tokens_between", arguments: "2026-09-01 2026-09-25" }),
    );
  });

  it("posts the builder's usage text when /tokens_between has no arguments", async () => {
    const { ctx, commands } = createContext();
    const usage = "Invalid arguments for /tokens_between\n\nExpected: /tokens_between YYYY-MM-DD";
    buildOutput.mockResolvedValue({ state: "output", title: "Tokens", output: usage });

    await setupPlugin(ctx);
    await runCommand(commands, "tokens_between", "   ");

    expect(buildOutput).toHaveBeenCalledWith(
      expect.objectContaining({ command: "tokens_between", arguments: undefined }),
    );
    expect(ctx.session.prompt.mock.calls[0][0].text).toBe(formatQuotaReportMessage(usage));
  });

  it("posts nothing when the plugin is disabled", async () => {
    const { ctx, commands } = createContext();
    buildOutput.mockResolvedValue({ state: "noop", command: "quota", reason: "disabled" });

    await setupPlugin(ctx);
    await runCommand(commands, "quota");

    expect(ctx.session.wait).not.toHaveBeenCalled();
    expect(ctx.session.prompt).not.toHaveBeenCalled();
  });

  it("removes only tagged quota reports from model requests", async () => {
    const { ctx, hooks } = createContext();
    await setupPlugin(ctx);
    const report = formatQuotaReportMessage("openai 42%");

    expect([...hooks.keys()]).toEqual(["context", "compaction", "generate", "title", "retry"]);
    for (const name of ["context", "compaction", "generate"]) {
      const tagged = user(report, { opencodeQuota: { command: "quota", title: "Quota", at: 1 } });
      const question = user("What is my quota?");
      const otherMetadata = user("Hello", { displayText: "Hello", comments: [] });
      const assistant: Message = {
        role: "assistant",
        metadata: { opencodeQuota: { command: "quota", title: "Quota", at: 1 } },
        content: [{ type: "text", text: "openai 42%" }],
      };
      const image: Message = { role: "user", content: [{ type: "media" }] };
      const event: HookEvent = {
        messages: [tagged, question, otherMetadata, assistant, image, { ...tagged }],
      };

      hook(hooks, name)(event);

      expect(event.messages).toEqual([question, otherMetadata, assistant, image]);
      expect(event.messages[0]).toBe(question);
      expect(event.messages[1]).toBe(otherMetadata);
    }
  });

  it("cuts reports out of compaction checkpoint text and keeps the rest", async () => {
    const { ctx, hooks } = createContext();
    await setupPlugin(ctx);
    const report = formatQuotaReportMessage("openai 42%\nanthropic 7%");
    const checkpoint: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `<recent-context>\n[User]: Fix the bug\n\n[User]: ${report}\n\n[Assistant]: Done\n</recent-context>`,
        },
        { type: "text", text: "no report here" },
      ],
    };
    const assistantEcho: Message = { role: "assistant", content: [{ type: "text", text: report }] };

    for (const name of ["context", "compaction", "generate"]) {
      const event: HookEvent = { messages: [checkpoint, assistantEcho] };

      hook(hooks, name)(event);

      expect(event.messages[0].content).toEqual([
        {
          type: "text",
          text: "<recent-context>\n[User]: Fix the bug\n\n[User]: \n\n[Assistant]: Done\n</recent-context>",
        },
        { type: "text", text: "no report here" },
      ]);
      expect(event.messages[0].content[1]).toBe(checkpoint.content[1]);
      expect(event.messages[1]).toBe(assistantEcho);
    }
    expect(checkpoint.content[0].text).toContain("openai 42%");
  });

  it("never titles a session from a quota report", async () => {
    const { ctx, hooks } = createContext();
    await setupPlugin(ctx);
    const title = hook(hooks, "title");
    const report = formatQuotaReportMessage("openai 42%");

    const reportOnly: HookEvent = { messages: [user(report)] };
    title(reportOnly);
    expect(reportOnly.result).toBe("");
    expect(reportOnly.messages).toEqual([user("")]);

    const mixed: HookEvent = {
      messages: [user(`Original request:\n${report}\n\nRecent conversation:\nUser: Fix the bug`)],
    };
    title(mixed);
    expect(mixed.result).toBeUndefined();
    expect(mixed.messages).toEqual([
      user("Original request:\n\n\nRecent conversation:\nUser: Fix the bug"),
    ]);

    const plain = user("Fix the bug");
    const normal: HookEvent = { messages: [plain] };
    title(normal);
    expect(normal.result).toBeUndefined();
    expect(normal.messages[0]).toBe(plain);
  });

  it("retries at the quota reset only when the quota data gives a delay", async () => {
    const { ctx, hooks } = createContext();
    await setupPlugin(ctx);
    const retry = hook(hooks, "retry") as unknown as (event: RetryEvent) => Promise<void>;
    const event = (decision: RetryEvent["decision"]): RetryEvent => ({
      sessionID: "session-1",
      agent: "build",
      model: { id: "glm-4.6", providerID: "zai-coding-plan" },
      error: { type: "provider.quota", message: "Usage limit reached", status: 429 },
      attempt: 2,
      decision,
    });

    resolveRetryDelay.mockResolvedValueOnce(5_460_000);
    const waiting = event({ retry: false });
    await retry(waiting);
    expect(waiting.decision).toEqual({ retry: true, delay: 5_460_000 });
    expect(resolveRetryDelay).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.anything(), roots: expect.anything() }),
      waiting,
    );

    resolveRetryDelay.mockResolvedValueOnce(undefined);
    const unchanged = event({ retry: true, delay: 2_000 });
    await retry(unchanged);
    expect(unchanged.decision).toEqual({ retry: true, delay: 2_000 });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveRetryDelay.mockRejectedValueOnce(new Error("quota read failed"));
    const failed = event({ retry: false });
    await expect(retry(failed)).resolves.toBeUndefined();
    expect(failed.decision).toEqual({ retry: false });
    expect(warn).toHaveBeenCalledWith("[opencode-quota] retry hook failed: quota read failed");
    warn.mockRestore();
  });

  it("reads logins through ctx.integration from setup until cleanup", async () => {
    const { ctx } = createContext();
    const integration = createFakeIntegration([
      {
        integrationId: "deepseek",
        id: "cred_deepseek",
        label: "default",
        registered: true,
        method: "key",
        value: { type: "key", key: "deepseek-key" },
      },
    ]);
    const subscribe = vi.fn((_options: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {},
    }));

    const cleanup = await setupPlugin({ ...ctx, integration, event: { subscribe } });
    expect(getCredentialSourceDiagnostics()).toMatchObject({
      state: "bound",
      kind: "opencode-integration-api",
    });
    await expect(readAuthFile({ integrationIds: ["deepseek"] })).resolves.toEqual({
      deepseek: { type: "api", key: "deepseek-key" },
    });
    const signal = subscribe.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);

    await cleanup?.();
    expect(signal?.aborted).toBe(true);
    // Only this setup's binding is gone; earlier tests' empty fakes hold no deepseek login.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readAuthFile({ integrationIds: ["deepseek"] })).resolves.toBeNull();
    warn.mockRestore();
    expect(integration.connection.active).toHaveBeenCalledOnce();
  });

  it.each([
    "credential.updated",
    "credential.switched",
  ])("drops cached logins when OpenCode reports %s", async (type) => {
    clearReadAuthFileCacheForTests();
    const { ctx } = createContext();
    const deepseek = {
      integrationId: "deepseek",
      id: "cred_deepseek",
      label: "default",
      registered: true,
      method: "key" as const,
      value: { type: "key", key: "old-key" } as Record<string, unknown>,
    };
    const integration = createFakeIntegration([deepseek]);
    let emit!: (event: { type: string; data: Record<string, unknown> }) => void;
    const nextEvent = new Promise<{ type: string; data: Record<string, unknown> }>((resolve) => {
      emit = resolve;
    });
    const subscribe = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "session.idle", data: {} };
        yield await nextEvent;
      },
    }));
    const cleanup = await setupPlugin({ ...ctx, integration, event: { subscribe } });
    const read = () => readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["deepseek"] });

    await expect(read()).resolves.toEqual({ deepseek: { type: "api", key: "old-key" } });
    deepseek.value = { type: "key", key: "new-key" };
    await expect(read()).resolves.toEqual({ deepseek: { type: "api", key: "old-key" } });

    emit({ type, data: { integrationID: "deepseek", credentialID: "cred_deepseek" } });
    await vi.waitFor(async () =>
      expect(await read()).toEqual({ deepseek: { type: "api", key: "new-key" } }),
    );
    await cleanup?.();
  });

  it("logs why the credential event subscription stopped, without tokens", async () => {
    const { ctx } = createContext();
    const token = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    const subscribe = vi.fn(() => ({
      // biome-ignore lint/correctness/useYield: the stream fails before its first event
      async *[Symbol.asyncIterator]() {
        throw new Error(`event stream closed ${token}`);
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await setupPlugin({ ...ctx, event: { subscribe } });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "[opencode-quota] credential event subscription stopped: event stream closed [redacted]",
      ),
    );
    await cleanup?.();
    warn.mockRestore();
  });

  it("stops the credential event subscription silently on cleanup", async () => {
    const { ctx } = createContext();
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        throw new DOMException("This operation was aborted", "AbortError");
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await setupPlugin({ ...ctx, event: { subscribe } });
    await cleanup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn.mock.calls.flat().join("\n")).not.toContain("credential event subscription");
    warn.mockRestore();
  });
});
