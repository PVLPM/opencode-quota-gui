export type DashboardRestartState = "idle" | "restarting" | "failed";

/** One recovery flow per shell; disposal must never reload an unmounted page. */
export function createDashboardRestart(
  operation: (signal: AbortSignal) => Promise<void>,
  reload: () => void,
  onState: (state: DashboardRestartState) => void,
) {
  let controller: AbortController | undefined;
  let disposed = false;
  let completed = false;
  return {
    async run(): Promise<void> {
      if (disposed || completed || controller) return;
      controller = new AbortController();
      onState("restarting");
      try {
        await operation(controller.signal);
        if (disposed) return;
        completed = true;
        reload();
      } catch {
        if (!disposed) onState("failed");
      } finally {
        if (!disposed) controller = undefined;
      }
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}
