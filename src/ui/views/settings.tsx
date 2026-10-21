import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type {
  DashboardDataSource,
  ImportPreview,
  JsonValue,
  SettingsSnapshot,
} from "../../contracts/dashboard";
import { EyeToggle } from "../components/eye-toggle";
import { GripDotsIcon } from "../components/icons";
import type { Toaster } from "../components/toast";
import { DashboardError } from "../dashboard-client";
import { Button, SegmentedControl, SegmentedControlItem, Switch, TextInput } from "../opencode-ui";
import {
  applyConflict,
  applyWriteResult,
  dirtyKeys,
  fieldErrors,
  initialDraft,
  keyboardMovedProviderOrder,
  OPENCODE_GO_WINDOWS,
  orderedProviderIds,
  parseIntegerInput,
  parseNumberInput,
  parseProviderIds,
  providerSelection,
  reorderedProviderOrder,
  SETTINGS_FIELDS,
  SETTINGS_GROUPS,
  type SettingsDraft,
  type SettingsField,
  settingProvenanceNote,
  stringList,
  toPatch,
  windowSelection,
} from "../settings-model";
import { describeError } from "../view-model";
import type { VisibilityCatalog, VisibilityProvider, VisibilityRow } from "../visibility-catalog";

export type { VisibilityCatalog, VisibilityProvider, VisibilityRow } from "../visibility-catalog";

/**
 * Settings (design spec §5.4, §7, §10; R14, R15).
 *
 * Grouped fields with inline validation, an inherited-source note per key, and
 * a save bar enabled only on change: the patch travels with `expectedRevision`,
 * `null` clears a key, and a 409 refetches, keeps the edits, and says the
 * settings changed elsewhere. The URL stays read-only, and the import
 * action is a preview → apply flow for eligible actual legacy sources.
 */
export function SettingsView(props: {
  snapshot: SettingsSnapshot;
  client: DashboardDataSource;
  toaster: Toaster;
  catalog: VisibilityCatalog;
  onReload: () => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = createSignal<SettingsDraft>(initialDraft(props.snapshot.revision));
  const [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<ImportPreview | undefined>(undefined);
  const [previewError, setPreviewError] = createSignal<string | undefined>(undefined);
  const [openingFile, setOpeningFile] = createSignal(false);
  const [openFileError, setOpenFileError] = createSignal<string | undefined>();
  const [providerText, setProviderText] = createSignal(
    providerSelection(props.snapshot.values.enabledProviders).ids.join(", "),
  );

  /**
   * The snapshot prop is reactive: a `settings.changed` refresh, a reconnect
   * refetch, or the reload after a 409 replaces it without remounting this
   * editor. A clean draft adopts the fresh revision; a draft with dirty edits
   * keeps them and records the revision the server will now accept, so an
   * explicit Save is checked against the file that is actually on disk. Edits
   * the fresh file already contains are not dirty any more, so they collapse
   * into a clean draft instead of overwriting the same value again.
   */
  createEffect(
    on(
      () => props.snapshot.revision,
      (revision) => {
        setDraft((current) => {
          if (current.revision === revision) return current;
          const stillDirty = dirtyKeys(current, props.snapshot.values, props.snapshot.writable);
          return stillDirty.length === 0
            ? initialDraft(revision)
            : applyConflict(current, revision);
        });
      },
    ),
  );

  /**
   * The provider text box mirrors the inherited selection while the field is
   * clean, so a refreshed snapshot shows up there too. Once the user has typed
   * — the key is edited — their text belongs to them and a refresh must not
   * drop it; switching modes or discarding puts the box back on the file.
   */
  createEffect(
    on(
      () => props.snapshot.values.enabledProviders,
      (value) => {
        if ("enabledProviders" in draft().edits) return;
        setProviderText(providerSelection(value).ids.join(", "));
      },
    ),
  );

  const editableFields = createMemo(() =>
    SETTINGS_FIELDS.filter(
      (field) =>
        !field.hidden &&
        field.control !== "readonly" &&
        props.snapshot.writable.includes(field.key),
    ),
  );
  const dirty = createMemo(() =>
    dirtyKeys(draft(), props.snapshot.values, props.snapshot.writable),
  );
  const errors = createMemo(() => fieldErrors(draft(), editableFields()));
  const errorFor = (key: string) => errors().find((error) => error.key === key)?.message;
  const fieldValue = (field: SettingsField): JsonValue | undefined =>
    field.key in draft().edits ? draft().edits[field.key] : props.snapshot.values[field.key];

  const sourceNote = (key: string): string | undefined =>
    settingProvenanceNote(props.snapshot, key);

  function edit(key: string, value: JsonValue | undefined): void {
    setDraft((current) => ({ ...current, edits: { ...current.edits, [key]: value } }));
  }

  function discard(): void {
    setDraft(initialDraft(props.snapshot.revision));
    setProviderText(providerSelection(props.snapshot.values.enabledProviders).ids.join(", "));
  }

  async function save(): Promise<void> {
    const patch = toPatch(draft(), dirty());
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    try {
      const result = await props.client.saveSettings({
        patch,
        expectedRevision: draft().revision,
      });
      setDraft(applyWriteResult(result));
      props.toaster.push(
        "success",
        "Global defaults saved. Project and workspace overrides still apply.",
      );
      await props.onReload();
    } catch (error) {
      if (isConfigChanged(error)) {
        props.toaster.push(
          "error",
          "Settings changed elsewhere. Your edits were kept — review them against the latest file.",
        );
        await props.onReload();
        // A successful reload has already moved the draft to the fresh revision
        // through the reconciliation effect above; if the reload failed the
        // draft still names the old revision, so flag the conflict instead of
        // pretending the file it will be checked against is current.
        setDraft((current) =>
          dirtyKeys(current, props.snapshot.values, props.snapshot.writable).length === 0
            ? current
            : applyConflict(current, props.snapshot.revision),
        );
      } else {
        props.toaster.push("error", describeError(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function openSettingsFile(): Promise<void> {
    if (openingFile()) return;
    setOpenFileError(undefined);
    if (!props.client.openSettingsFile) {
      setOpenFileError("Opening the settings file is not available with this server.");
      return;
    }
    setOpeningFile(true);
    try {
      await props.client.openSettingsFile();
    } catch (error) {
      setOpenFileError(describeError(error));
    } finally {
      setOpeningFile(false);
    }
  }

  async function previewImport(): Promise<void> {
    setBusy(true);
    setPreviewError(undefined);
    try {
      setPreview(await props.client.importPreview());
    } catch (error) {
      setPreviewError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function applyImport(): Promise<void> {
    const current = preview();
    if (!current) return;
    setBusy(true);
    try {
      const result = await props.client.importApply({ expectedRevision: current.expectedRevision });
      setPreview(undefined);
      setDraft(applyWriteResult(result));
      props.toaster.push(
        "success",
        "Copied to global defaults. Project and workspace overrides still apply.",
      );
      await props.onReload();
    } catch (error) {
      props.toaster.push(
        "error",
        isConfigChanged(error)
          ? "The settings file changed since the preview. Preview the import again."
          : describeError(error),
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Visibility (provider-grouped redesign).
   *
   * Ids live in the draft only and are never rendered: the provider cards hold
   * hidden-card semantics (provider eye: hide adds the provider id; show
   * removes the provider id and all its known card ids so a legacy card entry
   * cannot keep it hidden), the row eyes keep working while a provider is
   * hidden, and a reorder writes the complete current provider-id order to the
   * draft for the normal revision-checked save. Unknown retained ids in either
   * list survive every toggle and still never surface.
   */
  const [draggingProviderId, setDraggingProviderId] = createSignal<string | undefined>();
  const [dropTargetProviderId, setDropTargetProviderId] = createSignal<string | undefined>();
  const [providerOrderAnnouncement, setProviderOrderAnnouncement] = createSignal("");

  const valueForKey = (key: string): JsonValue | undefined =>
    key in draft().edits ? draft().edits[key] : props.snapshot.values[key];
  const hiddenCardIds = () => stringList(valueForKey("dashboard.hiddenCards"));
  const hiddenRowIds = () => stringList(valueForKey("dashboard.hiddenRows"));
  const providerOrderWritable = () => props.snapshot.writable.includes("dashboard.providerOrder");
  const hiddenCardsWritable = () => props.snapshot.writable.includes("dashboard.hiddenCards");
  const hiddenRowsWritable = () => props.snapshot.writable.includes("dashboard.hiddenRows");

  const orderedProviders = createMemo(() => {
    const catalogProviders = props.catalog.providers;
    const byId = new Map(catalogProviders.map((provider) => [provider.providerId, provider]));
    return orderedProviderIds(
      stringList(valueForKey("dashboard.providerOrder")),
      catalogProviders.map((provider) => provider.providerId),
    ).flatMap((id) => {
      const provider = byId.get(id);
      return provider === undefined ? [] : [provider];
    });
  });

  /** Hidden when the provider id is listed, or every known card of it is listed. */
  function providerEyeHidden(provider: VisibilityProvider): boolean {
    const hidden = hiddenCardIds();
    return (
      hidden.includes(provider.providerId) ||
      (provider.cardIds.length > 0 && provider.cardIds.every((cardId) => hidden.includes(cardId)))
    );
  }

  function toggleProviderEye(provider: VisibilityProvider): void {
    if (!hiddenCardsWritable() || busy()) return;
    const hidden = hiddenCardIds();
    if (providerEyeHidden(provider)) {
      edit(
        "dashboard.hiddenCards",
        hidden.filter((id) => id !== provider.providerId && !provider.cardIds.includes(id)),
      );
      return;
    }
    edit(
      "dashboard.hiddenCards",
      hidden.includes(provider.providerId) ? hidden : [...hidden, provider.providerId],
    );
  }

  /** Row state is independent of the provider eye and never cleared by it. */
  function toggleRowEye(row: VisibilityRow): void {
    if (!hiddenRowsWritable() || busy()) return;
    const hidden = hiddenRowIds();
    edit(
      "dashboard.hiddenRows",
      hidden.includes(row.id) ? hidden.filter((entry) => entry !== row.id) : [...hidden, row.id],
    );
  }

  function writeProviderOrder(next: string[], movedId: string, direction: string): void {
    const current = orderedProviders().map((provider) => provider.providerId);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    edit("dashboard.providerOrder", next);
    const label =
      props.catalog.providers.find((provider) => provider.providerId === movedId)?.providerLabel ??
      "";
    setProviderOrderAnnouncement(`${label} ${direction}.`);
  }

  function moveProvider(dragedId: string, toIndex: number): void {
    if (!providerOrderWritable()) return;
    const current = orderedProviders().map((provider) => provider.providerId);
    writeProviderOrder(reorderedProviderOrder(current, dragedId, toIndex), dragedId, "moved");
  }

  function moveProviderByKeyboard(providerId: string, step: -1 | 1): void {
    if (!providerOrderWritable()) return;
    const current = orderedProviders().map((provider) => provider.providerId);
    writeProviderOrder(
      keyboardMovedProviderOrder(current, providerId, step),
      providerId,
      step === -1 ? "moved up" : "moved down",
    );
  }

  function clearProviderDrag(): void {
    setDraggingProviderId(undefined);
    setDropTargetProviderId(undefined);
  }

  function onProviderDragStart(event: DragEvent, provider: VisibilityProvider): void {
    if (!providerOrderWritable()) return;
    event.dataTransfer?.setData("text/plain", provider.providerId);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
    setDraggingProviderId(provider.providerId);
  }

  function onProviderDragOver(event: DragEvent, provider: VisibilityProvider): void {
    const dragged = draggingProviderId();
    if (dragged === undefined || dragged === provider.providerId) return;
    // Marks the target and allows the drop; the visual is a subtle border only.
    event.preventDefault?.();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
    setDropTargetProviderId(provider.providerId);
  }

  function onProviderDrop(event: DragEvent, provider: VisibilityProvider): void {
    event.preventDefault?.();
    const dragged = draggingProviderId() ?? event.dataTransfer?.getData("text/plain");
    if (dragged !== undefined && dragged !== provider.providerId) {
      const index = orderedProviders().findIndex(
        (entry) => entry.providerId === provider.providerId,
      );
      if (index >= 0) moveProvider(dragged, index);
    }
    clearProviderDrag();
  }

  function onProviderDragEnd(): void {
    clearProviderDrag();
  }

  function onProviderGrabKey(event: KeyboardEvent, provider: VisibilityProvider): void {
    if (event.altKey !== true) return;
    if (event.key === "ArrowUp") {
      event.preventDefault?.();
      moveProviderByKeyboard(provider.providerId, -1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault?.();
      moveProviderByKeyboard(provider.providerId, 1);
    }
  }

  /** One dark card per provider: name, inline accounts, grip, eyes — no live values. */
  function renderVisibilitySection(): JSX.Element {
    return (
      <>
        <fieldset class="qg-vis-list" aria-label="Provider visibility">
          <Show
            when={orderedProviders().length > 0}
            fallback={
              <p class="qg-inherited">No provider accounts are available to configure yet.</p>
            }
          >
            <For each={orderedProviders()}>
              {(provider) => {
                const providerHidden = () => providerEyeHidden(provider);
                return (
                  <article
                    class="qg-vis-provider"
                    data-hidden={providerHidden() ? "true" : undefined}
                    data-dragging={
                      draggingProviderId() === provider.providerId ? "true" : undefined
                    }
                    data-drop={dropTargetProviderId() === provider.providerId ? "true" : undefined}
                    onDragOver={(event) => onProviderDragOver(event, provider)}
                    onDrop={(event) => onProviderDrop(event, provider)}
                    onDragEnd={onProviderDragEnd}
                  >
                    <header class="qg-vis-provider__head">
                      <button
                        type="button"
                        class="qg-vis-grip"
                        title="Drag to reorder; Alt plus arrow keys move it too"
                        aria-label={`Reorder ${provider.providerLabel}`}
                        draggable={providerOrderWritable()}
                        onDragStart={(event) => onProviderDragStart(event, provider)}
                        onDragEnd={onProviderDragEnd}
                        onKeyDown={(event) => onProviderGrabKey(event, provider)}
                      >
                        <GripDotsIcon />
                      </button>
                      <div class="qg-vis-provider__identity">
                        <span class="qg-vis-provider__name">{provider.providerLabel}</span>
                        <Show when={provider.accountLabels.length > 0}>
                          <span class="qg-vis-provider__account">
                            {provider.accountLabels.join(" · ")}
                          </span>
                        </Show>
                      </div>
                      <EyeToggle
                        variant="provider"
                        disabled={!hiddenCardsWritable() || busy()}
                        pressed={providerHidden()}
                        label={`${providerHidden() ? "Show" : "Hide"} ${provider.providerLabel}`}
                        title={providerHidden() ? "Show provider" : "Hide provider"}
                        onToggle={async () => toggleProviderEye(provider)}
                      />
                    </header>
                    <For each={provider.rows}>
                      {(row) => {
                        const rowHidden = () => hiddenRowIds().includes(row.id);
                        const rowAccount = () =>
                          needsAccountLabels(provider) ? row.accountLabel : undefined;
                        const rowName = () =>
                          rowAccount() === undefined ? row.label : `${row.label} · ${rowAccount()}`;
                        return (
                          <div class="qg-vis-row">
                            <span class="qg-vis-row__label">
                              {row.label}
                              <Show when={rowAccount()}>
                                {(account) => (
                                  <span class="qg-vis-row__account"> · {account()}</span>
                                )}
                              </Show>
                            </span>
                            <EyeToggle
                              variant="row"
                              disabled={!hiddenRowsWritable() || busy()}
                              pressed={rowHidden()}
                              label={`${rowHidden() ? "Show" : "Hide"} ${rowName()}`}
                              title={rowHidden() ? "Show" : "Hide"}
                              onToggle={async () => toggleRowEye(row)}
                            />
                          </div>
                        );
                      }}
                    </For>
                  </article>
                );
              }}
            </For>
          </Show>
        </fieldset>
        <span class="qg-inherited" aria-live="polite">
          {providerOrderAnnouncement()}
        </span>
      </>
    );
  }

  function renderControl(field: SettingsField): JSX.Element {
    const value = () => fieldValue(field);
    const writable = () =>
      field.control !== "readonly" && props.snapshot.writable.includes(field.key);

    switch (field.control) {
      case "switch": {
        const switchValue = () => (field.clearable ? value() === "runway" : value() === true);
        return (
          <>
            <Switch
              appearance="compact"
              hideLabel
              checked={switchValue()}
              disabled={!writable() || busy()}
              onChange={(checked) => {
                edit(field.key, field.clearable ? (checked ? "runway" : null) : checked);
              }}
            >
              {field.label}
            </Switch>
            <span class="qg-inherited" aria-hidden="true">
              {switchValue() ? "On" : "Off"}
            </span>
          </>
        );
      }
      case "select":
        return (
          <select
            class="qg-input"
            aria-label={field.label}
            disabled={!writable()}
            value={
              typeof value() === "string"
                ? (value() as string)
                : field.key === "percentLabelStyle"
                  ? "full"
                  : ""
            }
            onChange={(event) => edit(field.key, event.currentTarget.value)}
          >
            <For each={field.options ?? []}>
              {(option) => <option value={option.value}>{option.label}</option>}
            </For>
          </select>
        );
      case "number":
      case "integer":
        return (
          <>
            <TextInput
              class="qg-input"
              aria-label={field.label}
              numeric
              invalid={errorFor(field.key) !== undefined}
              disabled={!writable()}
              value={value() === undefined || value() === null ? "" : String(value())}
              onInput={(event) =>
                edit(
                  field.key,
                  field.control === "number"
                    ? parseNumberInput(event.currentTarget.value)
                    : parseIntegerInput(event.currentTarget.value),
                )
              }
            />
            <Show when={field.clearable}>
              <Button
                variant="ghost-muted"
                size="small"
                disabled={!writable()}
                onClick={() => edit(field.key, null)}
              >
                Clear
              </Button>
            </Show>
          </>
        );
      case "providers": {
        const selection = () => providerSelection(value());
        return (
          <>
            <SegmentedControl
              aria-label="Provider selection"
              value={selection().mode}
              disabled={!writable() || busy()}
              onChange={(mode) => {
                if (mode === "auto") edit(field.key, "auto");
                if (mode === "manual") edit(field.key, parseProviderIds(providerText()));
              }}
            >
              <SegmentedControlItem value="auto">Automatic</SegmentedControlItem>
              <SegmentedControlItem value="manual">Manual</SegmentedControlItem>
            </SegmentedControl>
            <Show when={selection().mode === "manual"}>
              <TextInput
                class="qg-input"
                disabled={!writable()}
                placeholder="provider ids, comma separated"
                value={providerText()}
                onInput={(event) => {
                  setProviderText(event.currentTarget.value);
                  edit(field.key, parseProviderIds(event.currentTarget.value));
                }}
              />
              <Show when={selection().ids.length === 0}>
                <span class="qg-inherited">An empty list enables no provider.</span>
              </Show>
            </Show>
          </>
        );
      }
      case "windows": {
        const selected = () => windowSelection(value());
        return (
          <For each={OPENCODE_GO_WINDOWS}>
            {(window) => (
              <label class="qg-checkbox-option">
                <input
                  type="checkbox"
                  checked={selected().includes(window)}
                  disabled={!writable()}
                  onChange={(event) => {
                    const next = event.currentTarget.checked
                      ? [...selected(), window]
                      : selected().filter((entry) => entry !== window);
                    edit(
                      field.key,
                      OPENCODE_GO_WINDOWS.filter((entry) => next.includes(entry)),
                    );
                  }}
                />
                <span>{window}</span>
              </label>
            )}
          </For>
        );
      }
      default:
        return <span class="qg-inherited">{String(value() ?? "—")}</span>;
    }
  }

  return (
    <div class="qg-settings">
      <div class="qg-form qg-settings__scroll">
        <header class="qg-section__head">
          <h1 class="qg-page-title">Settings</h1>
          <span class="qg-section__meta">Display, visibility and preferences</span>
        </header>
        <p class="qg-group__note">
          Changes on this page are saved as global defaults. Project and workspace overrides remain
          effective; saving here does not edit them. Meaningful overriding sources are noted beside
          affected fields.
        </p>
        <Show when={props.snapshot.import.available}>
          <section class="qg-group" aria-labelledby="qg-settings-import">
            <h2 class="qg-group__title" id="qg-settings-import">
              Legacy OpenCode Quota settings detected
            </h2>
            <p class="qg-group__note">
              Preview eligible settings before copying them into global defaults. Source files
              remain untouched.
            </p>
            <Show when={props.snapshot.import.issues.length > 0}>
              <ul class="qg-note-list">
                <For each={props.snapshot.import.issues}>
                  {(issue) => (
                    <li>
                      {issue.key}: {issue.message}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <div class="qg-field__control">
              <Button
                variant="outline"
                size="small"
                disabled={!props.snapshot.import.available || busy()}
                onClick={() => void previewImport()}
              >
                Preview migration
              </Button>
              <Show when={preview()}>
                {(current) => (
                  <>
                    <span class="qg-inherited">from {current().from}</span>
                    <Button
                      variant="contrast"
                      size="small"
                      disabled={busy()}
                      onClick={() => void applyImport()}
                    >
                      Apply {current().keys.length} keys
                    </Button>
                  </>
                )}
              </Show>
            </div>
            <Show when={previewError()}>
              {(message) => <p class="qg-field__error">{message()}</p>}
            </Show>
            <Show when={preview()}>
              {(current) => (
                <ul class="qg-note-list">
                  <For each={current().keys}>
                    {(key) => (
                      <li>
                        {key.key} → {JSON.stringify(key.value)}
                      </li>
                    )}
                  </For>
                </ul>
              )}
            </Show>
          </section>
        </Show>

        <For each={SETTINGS_GROUPS}>
          {(group) => (
            <Show when={editableFields().some((field) => field.group === group.id)}>
              <section class="qg-group" aria-labelledby={`qg-settings-${group.id}`}>
                <h2 class="qg-group__title" id={`qg-settings-${group.id}`}>
                  {group.title}
                </h2>
                <Show when={group.note}>{(note) => <p class="qg-group__note">{note()}</p>}</Show>
                <Show
                  when={group.id === "visibility"}
                  fallback={
                    <For each={editableFields().filter((field) => field.group === group.id)}>
                      {(field) => (
                        <div
                          class="qg-field"
                          data-invalid={errorFor(field.key) ? "true" : undefined}
                        >
                          <span class="qg-field__label">{field.label}</span>
                          <div class="qg-field__control">{renderControl(field)}</div>
                          <span class="qg-field__meta">
                            <Show when={field.help}>{(help) => <span>{help()}</span>}</Show>
                            <Show when={sourceNote(field.key)}>
                              {(note) => <span>{note()}</span>}
                            </Show>
                          </span>
                          <Show when={errorFor(field.key)}>
                            {(message) => <span class="qg-field__error">{message()}</span>}
                          </Show>
                        </div>
                      )}
                    </For>
                  }
                >
                  {renderVisibilitySection()}
                </Show>
              </section>
            </Show>
          )}
        </For>

        <section class="qg-group" aria-labelledby="qg-settings-dashboard">
          <h2 class="qg-group__title" id="qg-settings-dashboard">
            Dashboard
          </h2>
          <div class="qg-field">
            <span class="qg-field__label">Address</span>
            <div class="qg-field__control">
              <TextInput
                class="qg-input"
                aria-label="Dashboard address"
                readOnly
                value={props.snapshot.dashboard.url}
              />
            </div>
            <span class="qg-field__meta">
              <span>
                Bound to loopback only; the dashboard is not reachable from other machines.
              </span>
            </span>
          </div>
          <div class="qg-field">
            <span class="qg-field__label">Settings file</span>
            <div class="qg-field__control">
              <Button
                class="qg-settings-file"
                variant="ghost-muted"
                size="small"
                aria-label={`Open settings file: ${props.snapshot.pathLabel}`}
                aria-describedby="qg-settings-file-help"
                aria-busy={openingFile()}
                disabled={openingFile()}
                onClick={() => void openSettingsFile()}
              >
                {props.snapshot.pathLabel}
              </Button>
              <span class="qg-badge">revision {props.snapshot.revision.slice(0, 8)}</span>
            </div>
            <span class="qg-field__meta" id="qg-settings-file-help">
              Open in the default application. Unsaved changes are not included.
            </span>
            <Show when={openFileError()}>
              {(message) => (
                <p class="qg-field__error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
          </div>
          <Show when={props.snapshot.issues.length > 0}>
            <div class="qg-field">
              <span class="qg-field__label">Reported issues</span>
              <div class="qg-field__control">
                <ul class="qg-note-list">
                  <For each={props.snapshot.issues}>
                    {(issue) => (
                      <li>
                        {issue.label}: {issue.message} ({issue.key})
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </div>
          </Show>
        </section>
      </div>
      <div class="qg-savebar">
        <span class="qg-savebar__status" aria-live="polite">
          <Show when={dirty().length > 0} fallback={<span>No unsaved changes.</span>}>
            <span>{dirty().length} unsaved change(s)</span>
          </Show>
          <Show when={draft().conflict}>
            <span> · settings changed elsewhere — your edits are kept</span>
          </Show>
        </span>
        <div class="qg-field__control">
          <Button
            variant="ghost-muted"
            size="small"
            disabled={dirty().length === 0 || busy()}
            onClick={discard}
          >
            Discard
          </Button>
          <Button
            variant="contrast"
            size="small"
            disabled={dirty().length === 0 || errors().length > 0 || busy()}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function needsAccountLabels(provider: VisibilityProvider): boolean {
  if (provider.accountLabels.length > 1) return true;
  const labels = new Set<string>();
  for (const row of provider.rows) {
    if (labels.has(row.label)) return true;
    labels.add(row.label);
  }
  return false;
}

function isConfigChanged(error: unknown): boolean {
  return error instanceof DashboardError && error.isConfigChanged;
}
