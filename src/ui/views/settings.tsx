import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type {
  DashboardDataSource,
  ImportPreview,
  JsonValue,
  SettingsSnapshot,
} from "../../contracts/dashboard";
import type { Toaster } from "../components/toast";
import { DashboardError } from "../dashboard-client";
import { Button, TextInput } from "../opencode-ui";
import {
  applyConflict,
  applyWriteResult,
  dirtyKeys,
  fieldErrors,
  initialDraft,
  OPENCODE_GO_WINDOWS,
  parseIntegerInput,
  parseNumberInput,
  parseProviderIds,
  providerSelection,
  SETTINGS_FIELDS,
  SETTINGS_GROUPS,
  type SettingsDraft,
  type SettingsField,
  stringList,
  toPatch,
  windowSelection,
} from "../settings-model";
import { describeError } from "../view-model";

/** Last-seen cards and rows, so a visibility list can name what it hides. */
export interface VisibilityCatalog {
  cards: { id: string; label: string }[];
  rows: { id: string; label: string }[];
}

/**
 * Settings (design spec §5.4, §7, §10; R14, R15).
 *
 * Grouped fields with inline validation, an inherited-source note per key, and
 * a save bar enabled only on change: the patch travels with `expectedRevision`,
 * `null` clears a key, and a 409 refetches, keeps the edits, and says the
 * settings changed elsewhere. The port and URL stay read-only, and the import
 * action is a preview → apply flow that names the owner workspace.
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
  const [listDrafts, setListDrafts] = createSignal<Record<string, string>>({});
  const [providerText, setProviderText] = createSignal(
    providerSelection(props.snapshot.values.enabledProviders).ids.join(", "),
  );

  const editableFields = createMemo(() =>
    SETTINGS_FIELDS.filter(
      (field) => field.control !== "readonly" && props.snapshot.writable.includes(field.key),
    ),
  );
  const dirty = createMemo(() =>
    dirtyKeys(draft(), props.snapshot.values, props.snapshot.writable),
  );
  const errors = createMemo(() => fieldErrors(draft(), editableFields()));
  const errorFor = (key: string) => errors().find((error) => error.key === key)?.message;
  const fieldValue = (field: SettingsField): JsonValue | undefined =>
    field.key in draft().edits ? draft().edits[field.key] : props.snapshot.values[field.key];

  const sourceNote = (key: string): string | undefined => {
    const source = props.snapshot.sources[key];
    if (!source || source === props.snapshot.pathLabel) return undefined;
    return `inherited from ${source}`;
  };

  function edit(key: string, value: JsonValue | undefined): void {
    setDraft((current) => ({ ...current, edits: { ...current.edits, [key]: value } }));
  }

  function discard(): void {
    setDraft(initialDraft(props.snapshot.revision));
    setProviderText(providerSelection(props.snapshot.values.enabledProviders).ids.join(", "));
    setListDrafts({});
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
      props.toaster.push("success", "Settings saved.");
      await props.onReload();
    } catch (error) {
      if (isConfigChanged(error)) {
        props.toaster.push(
          "error",
          "Settings changed elsewhere. Your edits were kept — review them against the latest file.",
        );
        await props.onReload();
        setDraft((current) => applyConflict(current, props.snapshot.revision));
      } else {
        props.toaster.push("error", describeError(error));
      }
    } finally {
      setBusy(false);
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
      props.toaster.push("success", "Import applied.");
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

  function renderControl(field: SettingsField): JSX.Element {
    const value = () => fieldValue(field);
    const writable = () =>
      field.control !== "readonly" && props.snapshot.writable.includes(field.key);

    switch (field.control) {
      case "switch": {
        const switchValue = () => (field.clearable ? value() === "runway" : value() === true);
        return (
          <label class="qg-switch">
            <input
              type="checkbox"
              checked={switchValue()}
              disabled={!writable()}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                edit(field.key, field.clearable ? (checked ? "runway" : null) : checked);
              }}
            />
            <span>{switchValue() ? "On" : "Off"}</span>
          </label>
        );
      }
      case "select":
        return (
          <select
            class="qg-input"
            aria-label={field.label}
            disabled={!writable()}
            value={typeof value() === "string" ? (value() as string) : ""}
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
            <fieldset class="qg-segmented">
              <legend class="sr-only">Provider selection</legend>
              <button
                type="button"
                aria-pressed={selection().mode === "auto" ? "true" : "false"}
                disabled={!writable()}
                onClick={() => edit(field.key, "auto")}
              >
                Automatic
              </button>
              <button
                type="button"
                aria-pressed={selection().mode === "manual" ? "true" : "false"}
                disabled={!writable()}
                onClick={() => edit(field.key, parseProviderIds(providerText()))}
              >
                Manual
              </button>
            </fieldset>
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
              <label class="qg-switch">
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
      case "list": {
        const items = () => stringList(value());
        const labelFor = (id: string): string => {
          const entries =
            field.key === "dashboard.hiddenCards" ? props.catalog.cards : props.catalog.rows;
          return entries.find((entry) => entry.id === id)?.label ?? id;
        };
        return (
          <>
            <Show
              when={items().length > 0}
              fallback={<span class="qg-inherited">Nothing is hidden.</span>}
            >
              <div class="qg-visibility">
                <For each={items()}>
                  {(id) => (
                    <span class="qg-chip" title={id}>
                      <span>{labelFor(id)}</span>
                      <button
                        type="button"
                        aria-label={`Stop hiding ${labelFor(id)}`}
                        title="Clear"
                        disabled={!writable()}
                        onClick={() =>
                          edit(
                            field.key,
                            items().filter((entry) => entry !== id),
                          )
                        }
                      >
                        ×
                      </button>
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <TextInput
              class="qg-input"
              disabled={!writable()}
              placeholder="id to hide"
              value={listDrafts()[field.key] ?? ""}
              onInput={(event) =>
                setListDrafts((current) => ({ ...current, [field.key]: event.currentTarget.value }))
              }
            />
            <Button
              variant="ghost-muted"
              size="small"
              disabled={!writable() || (listDrafts()[field.key] ?? "").trim() === ""}
              onClick={() => {
                const id = (listDrafts()[field.key] ?? "").trim();
                if (id === "" || items().includes(id)) return;
                edit(field.key, [...items(), id]);
                setListDrafts((current) => ({ ...current, [field.key]: "" }));
              }}
            >
              Hide
            </Button>
            <Show when={items().length > 0}>
              <Button
                variant="ghost-muted"
                size="small"
                disabled={!writable()}
                onClick={() => edit(field.key, [])}
              >
                Clear all
              </Button>
            </Show>
          </>
        );
      }
      default:
        return <span class="qg-inherited">{String(value() ?? "—")}</span>;
    }
  }

  return (
    <div class="qg-form">
      <section class="qg-group" aria-labelledby="qg-settings-import">
        <h2 class="qg-group__title" id="qg-settings-import">
          Import from inherited settings
        </h2>
        <p class="qg-group__note">
          {props.snapshot.import.available
            ? `Lower layers supply ${props.snapshot.import.keyCount ?? 0} GUI keys. The import copies them into ${props.snapshot.pathLabel} revision-checked, and leaves the source files untouched.`
            : "No inherited settings are available to import in this workspace."}
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
            Preview import
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
        <Show when={previewError()}>{(message) => <p class="qg-field__error">{message()}</p>}</Show>
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

      <For each={SETTINGS_GROUPS}>
        {(group) => (
          <Show when={editableFields().some((field) => field.group === group.id)}>
            <section class="qg-group" aria-labelledby={`qg-settings-${group.id}`}>
              <h2 class="qg-group__title" id={`qg-settings-${group.id}`}>
                {group.title}
              </h2>
              <Show when={group.note}>{(note) => <p class="qg-group__note">{note()}</p>}</Show>
              <For each={editableFields().filter((field) => field.group === group.id)}>
                {(field) => (
                  <div class="qg-field" data-invalid={errorFor(field.key) ? "true" : undefined}>
                    <span class="qg-field__label">{field.label}</span>
                    <div class="qg-field__control">{renderControl(field)}</div>
                    <span class="qg-field__meta">
                      <Show when={field.help}>{(help) => <span>{help()}</span>}</Show>
                      <Show when={sourceNote(field.key)}>{(note) => <span>{note()}</span>}</Show>
                    </span>
                    <Show when={errorFor(field.key)}>
                      {(message) => <span class="qg-field__error">{message()}</span>}
                    </Show>
                  </div>
                )}
              </For>
            </section>
          </Show>
        )}
      </For>

      <section class="qg-group" aria-labelledby="qg-settings-dashboard">
        <h2 class="qg-group__title" id="qg-settings-dashboard">
          Dashboard
        </h2>
        <div class="qg-field">
          <span class="qg-field__label">Port</span>
          <div class="qg-field__control">
            <TextInput
              class="qg-input"
              numeric
              readOnly
              value={String(props.snapshot.dashboard.port)}
            />
          </div>
          <span class="qg-field__meta">
            <span>
              Read-only: changing the port needs a restart, and there is no fallback port.
            </span>
          </span>
        </div>
        <div class="qg-field">
          <span class="qg-field__label">Address</span>
          <div class="qg-field__control">
            <TextInput class="qg-input" readOnly value={props.snapshot.dashboard.url} />
          </div>
          <span class="qg-field__meta">
            <span>Bound to loopback only; the dashboard is not reachable from other machines.</span>
          </span>
        </div>
        <div class="qg-field">
          <span class="qg-field__label">Settings file</span>
          <div class="qg-field__control">
            <span class="qg-inherited">{props.snapshot.pathLabel}</span>
            <span class="qg-badge">revision {props.snapshot.revision.slice(0, 8)}</span>
          </div>
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

function isConfigChanged(error: unknown): boolean {
  return error instanceof DashboardError && error.isConfigChanged;
}
