import { beforeEach, describe, expect, it, vi } from "vitest";

import { QUOTA_DIALOG_COMMANDS } from "../src/lib/quota-dialog-command-specs.js";
import tuiPlugin from "../src/tui-v2.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";

// The TUI must never read logins or build reports itself: the server plugin does both.
const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  readAuthFile: vi.fn(),
  readAuthFileCached: vi.fn(),
  readCredentialRows: vi.fn(),
}));
vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>()),
  buildQuotaDialogCommandOutput: mocks.build,
}));
vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readAuthFile: mocks.readAuthFile,
  readAuthFileCached: mocks.readAuthFileCached,
  readCredentialRows: mocks.readCredentialRows,
}));

// Canned answers of the server plugin's quota RPC.
const rpc = {
  surface: vi.fn(),
  footer: vi.fn(),
  writeExport: vi.fn(),
  command: vi.fn(),
};

function startTui() {
  const commands = new Map<string, { run: () => Promise<void>; slash?: unknown }>();
  const listeners = new Map<string, (event: { data?: Record<string, unknown> }) => void>();
  const show = vi.fn((_render: () => unknown, onClose?: () => void) => onClose?.());
  const set = vi.fn();
  const prompt = vi.fn().mockResolvedValue(undefined);
  const toast = vi.fn();
  const slots = new Map<string, { render: (props?: { sessionID: string }) => unknown }>();
  const context = {
    location: { directory: process.cwd() },
    client: { rpc: vi.fn(() => rpc) },
    theme: { text: { base: "base", muted: "muted" } },
    data: {
      session: { get: vi.fn() },
      on: vi.fn((name: string, callback: (event: { data?: Record<string, unknown> }) => void) => {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      }),
    },
    keymap: {
      layer: vi.fn(
        (
          build: () => {
            mode?: string;
            commands: Array<{ id: string; run: () => Promise<void>; slash?: unknown }>;
          },
        ) => {
          // The palette layer; the typed-command Enter layer has no mode.
          const layer = build();
          if (layer.mode !== "global") return;
          for (const command of layer.commands) commands.set(command.id, command);
        },
      ),
    },
    ui: {
      slot: vi.fn(
        (claim: { append: string; render: (props?: { sessionID: string }) => unknown }) => {
          slots.set(claim.append, claim);
          if (claim.append === "app") claim.render();
          return vi.fn();
        },
      ),
      toast: { show: toast },
      router: { current: () => ({ type: "home" }) },
      dialog: { show, clear: vi.fn(), prompt, set },
    },
  };
  const dispose = tuiPlugin.setup(context as never);
  return { commands, listeners, show, set, prompt, toast, slots, context, dispose };
}

describe("V2 CLI command boundary", () => {
  beforeEach(() => {
    // The server plugin's dashboard setup reads the global config dir: keep it synthetic.
    vi.stubEnv("OPENCODE_CONFIG_DIR", "/tmp/opencode-quota-plugin-command-boundary/config");
    rpc.surface.mockReset().mockResolvedValue({
      quota: { message: "Copilot 81%", duration: 5000, activeProviderCount: 1 },
    });
    rpc.footer.mockReset().mockResolvedValue({ lines: ["Copilot 81%"] });
    rpc.writeExport.mockReset().mockResolvedValue({ written: false });
    rpc.command.mockReset().mockResolvedValue({
      state: "output",
      command: "quota",
      title: "Quota",
      output: "Quota ready",
      dialogSize: "large",
    });
  });

  it("registers the 12 palette commands without slash entries, not V1 server command hooks", () => {
    const tui = startTui();
    expect(tui.commands.size).toBe(12);
    expect([...tui.commands.keys()]).toEqual(
      QUOTA_DIALOG_COMMANDS.map((item) => `quota.${item.id}`),
    );
    expect([...tui.commands.values()].some((item) => item.slash !== undefined)).toBe(false);
    expect(new Set(QUOTA_DIALOG_COMMANDS.map((item) => item.id)).size).toBe(12);
    expect(tui.context.ui.slot).toHaveBeenCalledWith(expect.objectContaining({ append: "app" }));
    tui.dispose?.();
  });

  it("isolates commands from the model transcript and presents quota output locally", async () => {
    const tui = startTui();
    await tui.commands.get("quota.quota")?.run();
    expect(rpc.command).toHaveBeenCalledWith(
      { command: "quota", sessionID: undefined, arguments: undefined },
      expect.objectContaining({ location: { directory: process.cwd() } }),
    );
    expect(tui.show).toHaveBeenCalledOnce();
    expect(tui.set).toHaveBeenCalledWith({ size: "large" });
    expect(tui.context.data.session.get).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("passes the prompted /tokens_between range to the deterministic output builder", async () => {
    const tui = startTui();
    tui.prompt.mockResolvedValue("not-a-date-range");
    await tui.commands.get("quota.tokens_between")?.run();
    expect(rpc.command).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "tokens_between",
        arguments: "not-a-date-range",
      }),
      expect.anything(),
    );
    tui.dispose?.();
  });

  it("prompts for missing date ranges and does not invoke the command when cancelled", async () => {
    const tui = startTui();
    await tui.commands.get("quota.tokens_between")?.run();
    expect(tui.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ placeholder: "YYYY-MM-DD YYYY-MM-DD" }),
    );
    expect(rpc.command).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("returns without a dialog when quota is disabled", async () => {
    rpc.command.mockResolvedValue({ state: "noop", command: "quota", reason: "disabled" });
    const tui = startTui();
    await tui.commands.get("quota.quota")?.run();
    expect(tui.show).not.toHaveBeenCalled();
    expect(tui.toast).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("shows command failures as sanitized TUI error toasts rather than injecting a message", async () => {
    rpc.command.mockRejectedValue({ type: "rpc.internal", message: "quota unavailable" });
    const tui = startTui();
    await tui.commands.get("quota.quota")?.run();
    expect(tui.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "error",
        message: "quota unavailable",
      }),
    );
    expect(tui.show).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("never reads logins or builds reports in the TUI during setup, surfaces, and palette runs", async () => {
    vi.stubGlobal("React", {
      createElement: (type: unknown, props: Record<string, unknown> | null) =>
        typeof type === "function" ? type(props ?? {}) : { type, props },
    });
    const tui = startTui();
    tui.slots.get("sidebar.content")?.render({ sessionID: "ses_1" });
    tui.slots.get("prompt.footer")?.render({ sessionID: "ses_1" });
    tui.slots.get("home.footer.status")?.render();
    tui.listeners.get("session.execution.succeeded")?.({ data: { sessionID: "ses_1" } });
    for (const command of tui.commands.values()) await command.run();
    await vi.waitFor(() => expect(tui.toast).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(rpc.writeExport).toHaveBeenCalledOnce());

    expect(rpc.surface.mock.calls.map(([input]) => input)).toEqual([
      { surface: "sidebar", sessionID: "ses_1" },
      { surface: "idle", sessionID: "ses_1" },
    ]);
    expect(rpc.footer).toHaveBeenCalledTimes(2);
    // /tokens_between stops at its date prompt, which this fake cancels.
    expect(rpc.command).toHaveBeenCalledTimes(QUOTA_DIALOG_COMMANDS.length - 1);
    expect(mocks.readAuthFile).not.toHaveBeenCalled();
    expect(mocks.readAuthFileCached).not.toHaveBeenCalled();
    expect(mocks.readCredentialRows).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("does not offer V1 slash interception or agent-config normalization", async () => {
    // V2 TUI commands are local keymap registrations. The server plugin registers a tool and
    // V2 server commands for Web and Desktop; it has no V1 command.execute.before hook.
    const server = (await import("../src/plugin.js")).default;
    const transform = vi.fn();
    const commandTransform = vi.fn();
    const cleanup = await server.setup({
      location: { directory: process.cwd() },
      tool: { transform },
      command: { transform: commandTransform },
      session: { hook: vi.fn() },
      provider: { list: vi.fn() },
      rpc: {
        register: vi.fn(async () => ({ dispose: async () => {}, events: { emit: vi.fn() } })),
      },
      integration: createFakeIntegration([]),
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    } as never);
    expect(transform).toHaveBeenCalledOnce();
    expect(commandTransform).toHaveBeenCalledOnce();
    expect((server as Record<string, unknown>)["command.execute.before"]).toBeUndefined();
    expect((server as Record<string, unknown>).config).toBeUndefined();
    await cleanup?.();
  });
});
