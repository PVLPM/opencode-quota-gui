import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { orderCardsByPreference } from "../../contracts/card-order";
import type {
  DashboardDataSource,
  ImportPreview,
  JsonValue,
  SettingsSnapshot,
} from "../../contracts/dashboard";
import type { TemporalStatusSnapshot } from "../../contracts/temporal";
import { BuildAbout } from "../components/build-info";
import { EyeToggle } from "../components/eye-toggle";
import { GripDotsIcon } from "../components/icons";
import { ProviderLogo } from "../components/provider-logo";
import { TemporalInfoButton, temporalProviderLabel } from "../components/temporal-status";
import type { Toaster } from "../components/toast";
import { DashboardError } from "../dashboard-client";
import {
  Button,
  Icon,
  SegmentedControl,
  SegmentedControlItem,
  Switch,
  TextInput,
  Tooltip,
} from "../opencode-ui";
import {
  applyConflict,
  applyWriteResult,
  cardIdentityLabel,
  dirtyKeys,
  fieldErrors,
  initialDraft,
  isInheritedProviderHidden,
  keyboardMovedCardOrder,
  OPENCODE_GO_WINDOWS,
  parseIntegerInput,
  parseNumberInput,
  parseProviderIds,
  providerSelection,
  SETTINGS_FIELDS,
  SETTINGS_GROUPS,
  type SettingsDraft,
  type SettingsField,
  settingProvenanceNote,
  showCardKeepingKnownSiblingsHidden,
  stringList,
  temporalProviderOverridesFromValue,
  toggleHiddenCard,
  toPatch,
  visibilityAccountLabel,
  windowSelection,
} from "../settings-model";
import { createCardSorter, type SortableCardNodes } from "../sortable-cards";
import { describeError } from "../view-model";
import type { VisibilityCard, VisibilityCatalog, VisibilityRow } from "../visibility-catalog";

export type { VisibilityCard, VisibilityCatalog, VisibilityRow } from "../visibility-catalog";

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
  temporal?: TemporalStatusSnapshot;
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
      props.toaster.push("success", "Global settings saved.");
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
      props.toaster.push("success", "Copied to the global settings file.");
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

  /** Individual card identity is shared with Quota; all changes remain drafts. */
  const [draggingCardId, setDraggingCardId] = createSignal<string | undefined>();
  const [provisionalOrder, setProvisionalOrder] = createSignal<string[] | undefined>();
  const [cardOrderAnnouncement, setCardOrderAnnouncement] = createSignal("");
  let visibilityList: HTMLFieldSetElement | undefined;
  const cardNodes = new Map<string, Partial<SortableCardNodes>>();

  const valueForKey = (key: string): JsonValue | undefined =>
    key in draft().edits ? draft().edits[key] : props.snapshot.values[key];
  const hiddenCardIds = () => stringList(valueForKey("dashboard.hiddenCards"));
  const hiddenCardSet = createMemo(() => new Set(hiddenCardIds()));
  const hiddenRowIds = () => stringList(valueForKey("dashboard.hiddenRows"));
  const cardOrderWritable = () => props.snapshot.writable.includes("dashboard.cardOrder");
  const hiddenCardsWritable = () => props.snapshot.writable.includes("dashboard.hiddenCards");
  const hiddenRowsWritable = () => props.snapshot.writable.includes("dashboard.hiddenRows");
  const temporalProviderOverrides = () =>
    temporalProviderOverridesFromValue(valueForKey("dashboard.temporalProviderOverrides"));
  const temporalWritable = () =>
    props.snapshot.writable.includes("dashboard.temporalProviderOverrides");

  /**
   * Explicit choices persist as a sparse map. An absent provider follows
   * discovery, so a newly connected account defaults on without a write.
   */
  function toggleTemporalProvider(providerId: string, current: boolean): void {
    if (!temporalWritable() || busy()) return;
    edit("dashboard.temporalProviderOverrides", {
      ...temporalProviderOverrides(),
      [providerId]: !current,
    });
  }

  const orderedCards = createMemo(() =>
    orderCardsByPreference(
      props.catalog.cards,
      stringList(valueForKey("dashboard.cardOrder")),
      stringList(valueForKey("dashboard.providerOrder")),
    ),
  );
  const displayCards = createMemo(() =>
    provisionalOrder()
      ? orderCardsByPreference(orderedCards(), provisionalOrder())
      : orderedCards(),
  );

  function inheritedHidden(card: VisibilityCard): boolean {
    return isInheritedProviderHidden(card, hiddenCardSet(), props.catalog.cards);
  }

  function toggleCardEye(card: VisibilityCard): void {
    if (!hiddenCardsWritable() || busy()) return;
    const hidden = hiddenCardIds();
    edit(
      "dashboard.hiddenCards",
      inheritedHidden(card) || hidden.includes(card.cardId)
        ? showCardKeepingKnownSiblingsHidden(hidden, card, props.catalog.cards)
        : toggleHiddenCard(hidden, card.cardId),
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

  function writeCardOrder(next: string[], movedId: string): void {
    const current = orderedCards().map((card) => card.cardId);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    const unknown = stringList(valueForKey("dashboard.cardOrder")).filter(
      (id) => !current.includes(id),
    );
    edit("dashboard.cardOrder", [...next, ...new Set(unknown)]);
    const card = props.catalog.cards.find((entry) => entry.cardId === movedId);
    if (card)
      setCardOrderAnnouncement(
        `${cardIdentityLabel(card)} moved to position ${next.indexOf(movedId) + 1} of ${next.length}.`,
      );
  }
  const sorter = createCardSorter({
    ids: () => orderedCards().map((card) => card.cardId),
    container: () => visibilityList,
    nodes: (id) => {
      const nodes = cardNodes.get(id);
      return nodes?.slot && nodes.card && nodes.grip
        ? { slot: nodes.slot, card: nodes.card, grip: nodes.grip }
        : undefined;
    },
    enabled: () => cardOrderWritable() && !busy(),
    preview: setProvisionalOrder,
    active: setDraggingCardId,
    commit: writeCardOrder,
  });
  onCleanup(() => sorter.dispose());
  createEffect(() => {
    orderedCards();
    busy();
    sorter.cancel();
  });

  function registerNode<K extends keyof SortableCardNodes>(
    id: string,
    key: K,
    node: SortableCardNodes[K],
  ): void {
    const nodes = cardNodes.get(id) ?? {};
    nodes[key] = node;
    cardNodes.set(id, nodes);
  }

  function onCardGrabKey(event: KeyboardEvent, card: VisibilityCard): void {
    if (event.key === "Escape") {
      sorter.cancel();
      return;
    }
    if (!cardOrderWritable() || busy() || draggingCardId()) return;
    if (event.altKey !== true) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault?.();
      const current = orderedCards().map((entry) => entry.cardId);
      writeCardOrder(
        keyboardMovedCardOrder(current, card.cardId, event.key === "ArrowUp" ? -1 : 1),
        card.cardId,
      );
      // Solid applies keyed DOM moves after the event batch; restore focus afterward.
      queueMicrotask(() => cardNodes.get(card.cardId)?.grip?.focus({ preventScroll: true }));
    }
  }

  /**
   * Every temporal-capable provider, whether or not an account was discovered.
   * Discovery only decides the default; a switch writes an explicit choice.
   */
  function renderTemporalSection(): JSX.Element {
    const providers = () => props.temporal?.providers ?? [];
    const overrides = () => temporalProviderOverrides();
    const shownFor = (provider: { providerId: string; discovered: boolean }): boolean => {
      const override = overrides()[provider.providerId];
      return typeof override === "boolean" ? override : provider.discovered;
    };
    const explicitCount = () =>
      providers().filter((provider) => Object.hasOwn(overrides(), provider.providerId)).length;
    return (
      <>
        <Show
          when={providers().length > 0}
          fallback={<p class="qg-inherited">No temporal pricing providers are available.</p>}
        >
          <div class="qg-temporal-settings">
            <For each={providers()}>
              {(provider) => {
                const shown = () => shownFor(provider);
                const label = temporalProviderLabel(provider);
                return (
                  <div class="qg-field qg-temporal-settings__row">
                    <div class="qg-field__text">
                      <span class="qg-field__label qg-temporal-settings__identity">
                        <ProviderLogo
                          providerId={provider.providerId}
                          class="qg-temporal-settings__logo"
                        />
                        <span>{label}</span>
                        <TemporalInfoButton status={provider} />
                      </span>
                      <Show when={!provider.discovered}>
                        <span class="qg-field__meta">
                          <span class="qg-inherited">No account discovered.</span>
                        </span>
                      </Show>
                    </div>
                    <div class="qg-field__control">
                      <Switch
                        appearance="compact"
                        hideLabel
                        checked={shown()}
                        disabled={!temporalWritable() || busy()}
                        onChange={() => toggleTemporalProvider(provider.providerId, shown())}
                      >
                        Show peak and off-peak pricing for {label} on Quota
                      </Switch>
                      <span class="qg-inherited" aria-hidden="true">
                        {shown() ? "On" : "Off"}
                      </span>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
        <Show when={providers().length > 0}>
          <output class="qg-inherited" aria-live="polite">
            {explicitCount() > 0
              ? `${explicitCount()} manual ${explicitCount() === 1 ? "choice" : "choices"}; the rest follow discovered accounts.`
              : "Defaults follow discovered accounts."}
          </output>
        </Show>
      </>
    );
  }

  /** One card per Quota card, with the same identity hierarchy and its own rows. */
  function renderVisibilitySection(): JSX.Element {
    return (
      <>
        <fieldset
          ref={visibilityList}
          class="qg-vis-list"
          data-sorting={draggingCardId() !== undefined ? "true" : undefined}
          aria-label="Card visibility"
          onPointerMove={(event) => sorter.move(event)}
          onPointerUp={(event) => sorter.up(event)}
          onPointerCancel={(event) => sorter.lost(event)}
          onLostPointerCapture={(event) => sorter.lost(event)}
          onKeyDown={(event) => {
            if (event.key === "Escape") sorter.cancel();
          }}
        >
          <Show
            when={displayCards().length > 0}
            fallback={
              <p class="qg-inherited">No provider accounts are available to configure yet.</p>
            }
          >
            <For each={displayCards()}>
              {(card) => {
                const inherited = () => inheritedHidden(card);
                const cardHidden = () => inherited() || hiddenCardIds().includes(card.cardId);
                const lifted = () => draggingCardId() === card.cardId;
                return (
                  <div
                    class="qg-vis-slot"
                    data-lifted={lifted() ? "true" : undefined}
                    ref={(node) => registerNode(card.cardId, "slot", node)}
                  >
                    <article
                      class="qg-vis-provider"
                      ref={(node) => registerNode(card.cardId, "card", node)}
                      aria-label={cardIdentityLabel(card)}
                      data-hidden={cardHidden() ? "true" : undefined}
                      data-dragging={lifted() ? "true" : undefined}
                    >
                      <header class="qg-vis-provider__head">
                        <button
                          type="button"
                          class="qg-vis-grip"
                          title="Drag to reorder; Alt plus arrow keys move it too"
                          ref={(node) => registerNode(card.cardId, "grip", node)}
                          aria-label={`Reorder ${cardIdentityLabel(card)}`}
                          disabled={!cardOrderWritable() || busy()}
                          onPointerDown={(event) => sorter.down(card.cardId, event)}
                          onKeyDown={(event) => onCardGrabKey(event, card)}
                        >
                          <GripDotsIcon />
                        </button>
                        <div class="qg-vis-provider__identity">
                          <span class="qg-vis-provider__name">{card.providerLabel}</span>
                          <Show when={card.planLabel}>
                            {(plan) => <span class="qg-vis-provider__account">· {plan()}</span>}
                          </Show>
                          <Show when={card.accountLabel}>
                            {(account) => (
                              <span class="qg-vis-provider__account">
                                · {visibilityAccountLabel(card.providerLabel, account())}
                              </span>
                            )}
                          </Show>
                        </div>
                        <EyeToggle
                          variant="provider"
                          disabled={
                            !hiddenCardsWritable() || busy() || draggingCardId() !== undefined
                          }
                          pressed={cardHidden()}
                          label={`${cardHidden() ? "Show" : "Hide"} ${cardIdentityLabel(card)}`}
                          title={cardHidden() ? "Show card" : "Hide card"}
                          onToggle={async () => toggleCardEye(card)}
                        />
                      </header>
                      <For each={card.rows}>
                        {(row) => {
                          const rowHidden = () => hiddenRowIds().includes(row.id);
                          return (
                            <div class="qg-vis-row">
                              <span class="qg-vis-row__label">
                                <span class="qg-row__labelgroup">
                                  <span>{row.label}</span>
                                  <Show when={row.info}>
                                    {(info) => (
                                      <Tooltip
                                        value={info()}
                                        triggerTabIndex={0}
                                        appearance="large"
                                        contentClass="qg-row__tooltip"
                                      >
                                        <span class="sr-only">
                                          More information about {row.label}
                                        </span>
                                        <span class="qg-row__info" aria-hidden="true">
                                          <Icon name="info" size="small" />
                                        </span>
                                      </Tooltip>
                                    )}
                                  </Show>
                                </span>
                              </span>
                              <EyeToggle
                                variant="row"
                                disabled={
                                  !hiddenRowsWritable() || busy() || draggingCardId() !== undefined
                                }
                                pressed={rowHidden()}
                                label={`${rowHidden() ? "Show" : "Hide"} ${row.label}`}
                                title={rowHidden() ? "Show" : "Hide"}
                                onToggle={async () => toggleRowEye(row)}
                              />
                            </div>
                          );
                        }}
                      </For>
                    </article>
                  </div>
                );
              }}
            </For>
          </Show>
        </fieldset>
        <output class="qg-inherited" aria-live="polite">
          {cardOrderAnnouncement()}
        </output>
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
          Changes on this page are saved to the global GUI config file. Legacy settings are
          import-only; workspace settings are never live overrides. Meaningful legacy sources are
          noted in the import section.
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
            <Show
              when={
                editableFields().some((field) => field.group === group.id) ||
                (group.id === "temporal" && props.temporal !== undefined)
              }
            >
              <section class="qg-group" aria-labelledby={`qg-settings-${group.id}`}>
                <h2 class="qg-group__title" id={`qg-settings-${group.id}`}>
                  {group.title}
                </h2>
                <Show when={group.note}>{(note) => <p class="qg-group__note">{note()}</p>}</Show>
                <Show
                  when={group.id === "visibility"}
                  fallback={
                    <Show
                      when={group.id === "temporal"}
                      fallback={
                        <For each={editableFields().filter((field) => field.group === group.id)}>
                          {(field) => (
                            <div
                              class="qg-field"
                              data-invalid={errorFor(field.key) ? "true" : undefined}
                            >
                              <div class="qg-field__text">
                                <span class="qg-field__label">{field.label}</span>
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
                              <div class="qg-field__control">{renderControl(field)}</div>
                            </div>
                          )}
                        </For>
                      }
                    >
                      {renderTemporalSection()}
                    </Show>
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
            <div class="qg-field__text">
              <span class="qg-field__label">Address</span>
              <span class="qg-field__meta">
                <span>
                  Bound to loopback only; the dashboard is not reachable from other machines.
                </span>
              </span>
            </div>
            <div class="qg-field__control">
              <TextInput
                class="qg-input"
                aria-label="Dashboard address"
                readOnly
                value={props.snapshot.dashboard.url}
              />
            </div>
          </div>
          <div class="qg-field">
            <div class="qg-field__text">
              <span class="qg-field__label">Settings file</span>
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
          </div>
          <Show when={props.snapshot.issues.length > 0}>
            <div class="qg-field">
              <div class="qg-field__text">
                <span class="qg-field__label">Reported issues</span>
              </div>
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

        <BuildAbout />
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
            disabled={dirty().length === 0 || busy() || draggingCardId() !== undefined}
            onClick={discard}
          >
            Discard
          </Button>
          <Button
            variant="contrast"
            size="small"
            disabled={
              dirty().length === 0 ||
              errors().length > 0 ||
              busy() ||
              draggingCardId() !== undefined
            }
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
