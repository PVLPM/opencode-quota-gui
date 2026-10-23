import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/tui-v2.tsx";

const REFRESH_INTERVAL_MS = 60_000;

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

// Canned answers of the server plugin's quota RPC.
const rpc = {
  surface: vi.fn(),
  footer: vi.fn(),
  writeExport: vi.fn(),
  command: vi.fn(),
};
const client = { rpc: vi.fn(() => rpc) };

function setupFooterSlots(
  handlers = new Map<string, (event: unknown) => void>(),
): Map<string, (props?: any) => unknown> {
  const renderers = new Map<string, (props?: any) => unknown>();
  plugin.setup({
    client,
    theme: { text: { base: "base", muted: "muted" } },
    data: {
      location: { default: () => ({ directory: "/work/default" }) },
      on: vi.fn((event: string, handler: (event: unknown) => void) => {
        handlers.set(event, handler);
        return vi.fn();
      }),
      session: {
        get: (sessionID: string) =>
          sessionID === "ses_child" ? { parentID: "ses_parent" } : { id: sessionID },
      },
    },
    keymap: { layer: vi.fn() },
    ui: {
      slot: vi.fn((claim) => {
        renderers.set(claim.append, claim.render);
        return vi.fn();
      }),
      toast: { show: vi.fn() },
      dialog: { show: vi.fn(), clear: vi.fn(), prompt: vi.fn(), set: vi.fn() },
    },
  } as any);
  return renderers;
}

function mountSlot(render: ((props?: any) => unknown) | undefined, props?: unknown): () => void {
  return createRoot((dispose) => {
    render?.(props);
    return dispose;
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("V2 footer refresh timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("React", {
      createElement: (type: unknown, props: Record<string, unknown> | null) =>
        typeof type === "function" ? type(props ?? {}) : { type, props },
    });
    rpc.surface.mockReset().mockResolvedValue({ quota: null });
    rpc.footer.mockReset().mockResolvedValue({ lines: ["Copilot 50%"] });
    rpc.writeExport.mockReset().mockResolvedValue({ written: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refreshes the Home footer and writes the export every minute until unmount", async () => {
    const renderers = setupFooterSlots();
    const dispose = mountSlot(renderers.get("home.footer.status"));
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(1);
    expect(rpc.writeExport).toHaveBeenCalledTimes(1);
    expect(rpc.writeExport).toHaveBeenCalledWith({}, expect.anything());

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS - 1);
    expect(rpc.footer).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(2);
    expect(rpc.writeExport).toHaveBeenCalledTimes(2);

    dispose();
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3);
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(2);
    expect(rpc.writeExport).toHaveBeenCalledTimes(2);
  });

  it("refreshes the prompt footer every minute without writing the export", async () => {
    const renderers = setupFooterSlots();
    const dispose = mountSlot(renderers.get("prompt.footer"), { sessionID: "ses_1" });
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(2);

    dispose();
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3);
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(2);
    expect(rpc.writeExport).not.toHaveBeenCalled();
  });

  it("loads the prompt footer for the session its composer passes in", async () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const renderers = setupFooterSlots(handlers);
    const dispose = mountSlot(renderers.get("prompt.footer"), { sessionID: "ses_2" });
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(1);
    expect(rpc.footer.mock.calls[0][0]).toEqual({ surface: "prompt", sessionID: "ses_2" });

    handlers.get("session.step.ended")?.({ data: { sessionID: "ses_1" } });
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(1);

    handlers.get("session.step.ended")?.({ data: { sessionID: "ses_2" } });
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(2);
    expect(rpc.footer.mock.calls[1][0]).toEqual({ surface: "prompt", sessionID: "ses_2" });
    dispose();
  });

  it("asks the server for the Home prompt footer without a session", async () => {
    const renderers = setupFooterSlots();
    const dispose = mountSlot(renderers.get("prompt.footer"), {
      sessionID: undefined,
      mode: "normal",
      showDetails: true,
    });
    await flushPromises();

    // The server answers a prompt footer without a session with no lines.
    expect(rpc.footer).toHaveBeenCalledExactlyOnceWith(
      { surface: "prompt", sessionID: undefined },
      expect.anything(),
    );
    expect(rpc.writeExport).not.toHaveBeenCalled();
    dispose();
  });

  it("skips idle, compaction, and question toasts for subagent sessions, as in v4", async () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const renderers = setupFooterSlots(handlers);
    mountSlot(renderers.get("app"));
    handlers.get("session.execution.succeeded")?.({ data: { sessionID: "ses_child" } });
    handlers.get("session.compaction.ended")?.({ data: { sessionID: "ses_child" } });
    handlers.get("session.tool.input.started")?.({
      data: { sessionID: "ses_child", id: "call_1", name: "question" },
    });
    handlers.get("session.tool.success")?.({ data: { sessionID: "ses_child", id: "call_1" } });
    await flushPromises();
    expect(rpc.surface).not.toHaveBeenCalled();

    handlers.get("session.execution.succeeded")?.({ data: { sessionID: "ses_parent" } });
    await flushPromises();
    expect(rpc.surface).toHaveBeenCalledExactlyOnceWith(
      { surface: "idle", sessionID: "ses_parent" },
      expect.anything(),
    );
  });

  it("asks the server for Home without a session", async () => {
    const renderers = setupFooterSlots();
    const dispose = mountSlot(renderers.get("home.footer.status"));
    await flushPromises();

    expect(rpc.footer).toHaveBeenCalledExactlyOnceWith(
      { surface: "home", sessionID: undefined },
      expect.anything(),
    );
    dispose();
  });

  it("calls the RPC at the TUI location with a one-minute timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const handlers = new Map<string, (event: unknown) => void>();
    const renderers = setupFooterSlots(handlers);
    expect(client.rpc).not.toHaveBeenCalled();
    mountSlot(renderers.get("app"));
    const dispose = mountSlot(renderers.get("home.footer.status"));
    handlers.get("session.execution.succeeded")?.({ data: { sessionID: "ses_parent" } });
    await flushPromises();

    const { QuotaRpc } = await import("../src/rpc.js");
    expect(client.rpc).toHaveBeenCalledWith(QuotaRpc);
    const calls = [
      ...rpc.footer.mock.calls,
      ...rpc.writeExport.mock.calls,
      ...rpc.surface.mock.calls,
    ];
    expect(calls).toHaveLength(3);
    for (const [, options] of calls) {
      expect(options).toEqual({
        location: { directory: "/work/default" },
        signal: expect.any(AbortSignal),
      });
    }
    expect(timeout).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenCalledWith(60_000);
    dispose();
  });

  it("logs a failed load with the RPC error message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rpc.footer.mockRejectedValueOnce({ type: "rpc.internal", message: "server broke" });
    rpc.footer.mockRejectedValueOnce({ type: "rpc.unavailable", message: "no rpc" });
    const renderers = setupFooterSlots();
    mountSlot(renderers.get("home.footer.status"))();
    mountSlot(renderers.get("home.footer.status"))();
    await flushPromises();

    expect(warn.mock.calls).toEqual([
      ["[opencode-quota-gui] failed to load quota: server broke"],
      [
        "[opencode-quota-gui] failed to load quota: no rpc (OpenCode Quota GUI's server plugin is not loaded for this folder)",
      ],
    ]);
    expect(rpc.writeExport).not.toHaveBeenCalled();
  });

  it("drops a Home result and skips the export when the view unmounts mid-load", async () => {
    const load = deferred<unknown>();
    rpc.footer.mockReturnValueOnce(load.promise);
    const renderers = setupFooterSlots();
    const dispose = mountSlot(renderers.get("home.footer.status"));
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(1);

    dispose();
    load.resolve({ lines: [] });
    await flushPromises();
    expect(rpc.writeExport).not.toHaveBeenCalled();
  });

  it("coalesces refreshes that arrive while a footer load is running into one follow-up load", async () => {
    const load = deferred<unknown>();
    rpc.footer.mockReturnValueOnce(load.promise);
    const handlers = new Map<string, (event: unknown) => void>();
    const renderers = setupFooterSlots(handlers);
    const dispose = mountSlot(renderers.get("home.footer.status"));
    await flushPromises();

    handlers.get("session.step.ended")?.({ data: { sessionID: "ses_1" } });
    handlers.get("session.step.ended")?.({ data: { sessionID: "ses_1" } });
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(1);

    load.resolve({ lines: [] });
    await flushPromises();
    expect(rpc.footer).toHaveBeenCalledTimes(2);
    expect(rpc.writeExport).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("stops sidebar refreshes and drops their results after unmount", async () => {
    const load = deferred<unknown>();
    rpc.surface.mockReturnValueOnce(load.promise);
    const handlers = new Map<string, (event: unknown) => void>();
    const renderers = setupFooterSlots(handlers);
    const dispose = mountSlot(renderers.get("sidebar.content"), { sessionID: "ses_1" });
    await flushPromises();
    expect(rpc.surface).toHaveBeenCalledExactlyOnceWith(
      { surface: "sidebar", sessionID: "ses_1" },
      expect.anything(),
    );

    handlers.get("session.step.ended")?.({ data: { sessionID: "ses_1" } });
    dispose();
    load.resolve({ quota: null });
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 2);
    await flushPromises();
    expect(rpc.surface).toHaveBeenCalledTimes(1);
  });
});
