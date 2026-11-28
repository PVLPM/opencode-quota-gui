import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardDataSource, SettingsSnapshot } from "../src/contracts/dashboard";
import { createToaster } from "../src/ui/components/toast";
import { SettingsView } from "../src/ui/views/settings";
import { settingsSnapshot } from "./fixtures/gui-ui-fixtures";

/**
 * Imported-history deletion in Settings (v1.4.0 D10).
 *
 * The two import switches stay settings drafts. Deletion is a separate action
 * next to its own switch: one click asks for confirmation, the second commits,
 * and the outcome is reported in place. Only counts are shown.
 */

const IMPORT_KEYS = ["usageImport.claudeCode", "usageImport.codex"] as const;

/**
 * Only the two import keys are writable, so the page renders its usage-import
 * group without pulling in the provider segmented control this DOM environment
 * cannot measure.
 */
function mountedSnapshot(): SettingsSnapshot {
  const base = settingsSnapshot();
  return {
    ...base,
    values: { ...base.values, "usageImport.claudeCode": true, "usageImport.codex": false },
    writable: [...IMPORT_KEYS],
  };
}

function mount(deleteImportedHistory?: DashboardDataSource["deleteImportedHistory"]) {
  const target = document.createElement("div");
  document.body.append(target);
  const client = {
    saveSettings: vi.fn(),
    openSettingsFile: vi.fn(),
    importPreview: vi.fn(),
    importApply: vi.fn(),
    ...(deleteImportedHistory === undefined ? {} : { deleteImportedHistory }),
  } as unknown as DashboardDataSource;
  const dispose = render(
    () =>
      createComponent(SettingsView, {
        snapshot: mountedSnapshot(),
        client,
        toaster: createToaster(),
        catalog: { cards: [] },
        onReload: async () => {},
      }),
    target,
  );
  return { target, dispose, client };
}

function row(target: HTMLElement, harness: "claude-code" | "codex"): HTMLElement {
  const found = target.querySelector<HTMLElement>(`[data-usage-import-delete="${harness}"]`);
  if (found === null) throw new Error(`no delete row for ${harness}`);
  return found;
}

function button(parent: HTMLElement, label: string): HTMLButtonElement {
  const found = parent.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (found === null) throw new Error(`no button labelled ${label}`);
  return found;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Settings imported-history deletion DOM", () => {
  it("asks for confirmation before deleting and reports the deleted counts", async () => {
    const remove = vi.fn(async () => ({ invocations: 4, rateLimitSeries: 0 }));
    const { target, dispose } = mount(remove);

    const claude = row(target, "claude-code");
    expect(claude.textContent).toContain("Imported Claude Code history");
    // Nothing is deleted by the first click.
    button(claude, "Delete imported Claude Code history").click();
    expect(remove).not.toHaveBeenCalled();
    expect(claude.textContent).toContain("This cannot be undone");
    expect(claude.textContent).toContain("still on, the next refresh imports it again");

    button(claude, "Confirm deleting imported Claude Code history").click();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("claude-code"));

    await vi.waitFor(() =>
      expect(claude.textContent).toContain("Deleted 4 imported invocations for Claude Code."),
    );
    // The confirmation is gone and the row is back to its idle action.
    expect(
      claude.querySelector('button[aria-label="Confirm deleting imported Claude Code history"]'),
    ).toBeNull();
    expect(button(claude, "Delete imported Claude Code history")).toBeDefined();
    dispose();
  });

  it("cancels without deleting and offers no dialog for the other harness", () => {
    const remove = vi.fn(async () => ({ invocations: 0, rateLimitSeries: 0 }));
    const { target, dispose } = mount(remove);

    const codex = row(target, "codex");
    button(codex, "Delete imported Codex history").click();
    expect(codex.textContent).toContain("Delete the imported Codex history?");

    button(codex, "Cancel deleting imported Codex history").click();

    expect(remove).not.toHaveBeenCalled();
    expect(codex.textContent).not.toContain("Delete the imported Codex history?");
    // The other harness keeps its own idle action; a confirmation is per row.
    expect(button(row(target, "claude-code"), "Delete imported Claude Code history")).toBeDefined();
    dispose();
  });

  it("reports a failure in place and keeps the action available", async () => {
    const remove = vi.fn(async () => {
      throw new Error("boom");
    });
    const { target, dispose } = mount(remove);

    const codex = row(target, "codex");
    button(codex, "Delete imported Codex history").click();
    button(codex, "Confirm deleting imported Codex history").click();

    await vi.waitFor(() => expect(codex.querySelector('[role="alert"]')).not.toBeNull());
    expect(codex.textContent).not.toContain("Deleted");
    expect(button(codex, "Delete imported Codex history")).toBeDefined();
    dispose();
  });

  it("hides the action on a host that offers no delete seam", () => {
    const { target, dispose } = mount(undefined);

    expect(target.querySelector("[data-usage-import-delete]")).toBeNull();
    // The switches themselves stay rendered from the same table.
    expect(target.textContent).toContain("Claude Code");
    dispose();
  });
});
