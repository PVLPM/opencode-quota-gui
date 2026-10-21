import { Plugin } from "@opencode/plugin/tui";
import { type RGBA, type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { type JSX, useTerminalDimensions } from "@opentui/solid";
import { createSignal, onCleanup, Show } from "solid-js";

import { loadConfig } from "./lib/config.js";
import { resolveOpenCodeLocationRoots } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { fitTableToWidth } from "./lib/markdown-table.js";
import { layoutQuotaTables, type QuotaBlock, type QuotaTable } from "./lib/quota-columns.js";
import {
  parseQuotaSlashCommand,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-command-specs.js";
import { readQuotaReportMetadata } from "./lib/quota-report-message.js";
import {
  type ReportBlock,
  type ReportDocument,
  type ReportQuotaRow,
  type ReportSection,
  renderableSections,
  renderKvRow,
} from "./lib/report-document.js";
import type { TuiCommandDisplay } from "./lib/types.js";
import {
  QuotaRpc,
  type QuotaRpcCommandInput,
  type QuotaRpcCommandOutput,
  type QuotaRpcFooterInput,
  type QuotaRpcFooterOutput,
  type QuotaRpcSurfaceInput,
  type QuotaRpcSurfaceOutput,
  type QuotaRpcWriteExportInput,
  type QuotaRpcWriteExportOutput,
} from "./rpc.js";

const REFRESH_INTERVAL_MS = 60_000;
const RPC_TIMEOUT_MS = 60_000;

type TuiEvent = { data?: Record<string, unknown> };
type Toast = {
  variant?: "info" | "success" | "warning" | "error";
  title?: string;
  message: string;
  duration?: number;
};
type KeymapCommand = {
  id?: string;
  title?: string;
  group?: string;
  bind?: string;
  palette?: true;
  /** Returning false lets the key continue to the next layer. */
  run: () => void | false | Promise<void>;
};
type DialogSize = "medium" | "large" | "xlarge";
type DialogTheme = {
  text: { base: RGBA; muted: RGBA; action: { primary: { focused: RGBA; selected: RGBA } } };
  background: { action: { primary: { focused: RGBA } } };
};
type QuotaRpcCallOptions = { location: { directory: string }; signal: AbortSignal };
type QuotaRpcClient = {
  surface: (
    input: QuotaRpcSurfaceInput,
    options: QuotaRpcCallOptions,
  ) => Promise<QuotaRpcSurfaceOutput>;
  footer: (
    input: QuotaRpcFooterInput,
    options: QuotaRpcCallOptions,
  ) => Promise<QuotaRpcFooterOutput>;
  writeExport: (
    input: QuotaRpcWriteExportInput,
    options: QuotaRpcCallOptions,
  ) => Promise<QuotaRpcWriteExportOutput>;
  command: (
    input: QuotaRpcCommandInput,
    options: QuotaRpcCallOptions,
  ) => Promise<QuotaRpcCommandOutput>;
};
type TuiContext = {
  location?: { directory: string };
  renderer: { currentFocusedEditor: { plainText: string; clear: () => void } | null };
  client: {
    rpc: (definition: typeof QuotaRpc) => QuotaRpcClient;
    session: {
      inbox: { cancel: (input: { sessionID: string; inboxID: string }) => Promise<void> };
    };
  };
  theme: { text: { base: RGBA; muted: RGBA }; surface: (name: "dialog") => DialogTheme };
  data: {
    on: (event: string, handler: (event: TuiEvent) => void) => () => void;
    session: {
      get: (sessionID: string) => { parentID?: string } | undefined;
    };
    location?: {
      default: () => { directory: string };
      provider: { list: (location: { directory: string }) => Array<{ id: string }> | undefined };
    };
  };
  keymap: {
    /** Without a mode, a layer is active only in OpenCode's base mode. */
    layer: (
      build: () => { mode?: "global" | "modal"; priority?: number; commands: KeymapCommand[] },
    ) => void;
  };
  ui: {
    slot: (
      claim:
        | { append: "app"; render: () => null }
        | { append: "sidebar.content"; render: (props: { sessionID: string }) => JSX.Element }
        | { append: "prompt.footer"; render: (props: { sessionID?: string }) => JSX.Element }
        | { append: "home.footer.status"; render: () => JSX.Element },
    ) => () => void;
    router: {
      current: () => { type: "home" } | { type: "session"; sessionID: string } | { type: "plugin" };
    };
    toast: { show: (toast: Toast) => void };
    dialog: {
      show: (render: () => JSX.Element, onClose?: () => void) => void;
      clear: () => void;
      prompt: (params: { title: string; placeholder?: string }) => Promise<string | undefined>;
      set: (params: { size: DialogSize }) => void;
    };
  };
};

function getSessionID(event: TuiEvent): string | undefined {
  const sessionID = event.data?.sessionID;
  return typeof sessionID === "string" && sessionID ? sessionID : undefined;
}

function quotaClient(context: TuiContext) {
  return {
    config: {
      get: async () => ({ data: {} }),
      providers: async () => ({
        data: {
          providers:
            context.data.location?.provider.list(
              context.location ?? context.data.location.default(),
            ) ?? [],
        },
      }),
    },
  };
}

/** Same project roots as the server plugin: the location's Git worktree, else the location directory. */
function quotaRoots(context: TuiContext) {
  return resolveOpenCodeLocationRoots(context.location?.directory ?? process.cwd());
}

/**
 * The server plugin computes every quota surface; the TUI asks it over the quota RPC. The
 * RPC client is made per call, never during setup. Each call names the TUI's location, so
 * the server uses that folder's settings, and gives up after a minute.
 */
function quotaRpc(context: TuiContext): QuotaRpcClient {
  return context.client.rpc(QuotaRpc);
}

function quotaRpcOptions(context: TuiContext): QuotaRpcCallOptions {
  return {
    location: context.location ?? context.data.location!.default(),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  };
}

async function getQuotaMessage(
  context: TuiContext,
  sessionID: string,
  surface: QuotaRpcSurfaceInput["surface"],
) {
  const output = await quotaRpc(context).surface({ surface, sessionID }, quotaRpcOptions(context));
  return output.quota ?? undefined;
}

/** RPC calls reject with a plain `{ type, message }` object, not an Error. */
function rpcErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

/**
 * One view's refresh loop, as in v4 (tui-refresh-lifecycle.ts): a refresh that
 * arrives while a load runs is coalesced into one follow-up load, and a result is
 * dropped when the view was disposed or a newer load started.
 */
function createViewRefresh<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
): { refresh: () => void; dispose: () => void } {
  let disposed = false;
  let loadVersion = 0;
  let inFlight = false;
  let queued = false;
  const refresh = () => {
    if (disposed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    const currentVersion = ++loadVersion;
    void load()
      .then((value) => {
        if (disposed || currentVersion !== loadVersion) return;
        apply(value);
      })
      .catch(reportFailure)
      .finally(() => {
        if (disposed) return;
        inFlight = false;
        if (queued) {
          queued = false;
          refresh();
        }
      });
  };
  return {
    refresh,
    dispose: () => {
      disposed = true;
    },
  };
}

function QuotaFooter(props: {
  context: TuiContext;
  sessionID?: string;
  surface: "prompt" | "home";
}): JSX.Element {
  const [lines, setLines] = createSignal<string[]>([]);
  const view = createViewRefresh(
    async () => {
      const output = await quotaRpc(props.context).footer(
        { surface: props.surface, sessionID: props.sessionID },
        quotaRpcOptions(props.context),
      );
      return output.lines;
    },
    (next) => {
      setLines(next);
      if (props.surface !== "home") return;
      // Fire-and-forget: the server writes the export file if enabled. A failed write
      // must never affect rendering, so log a warning and continue.
      void quotaRpc(props.context)
        .writeExport({}, quotaRpcOptions(props.context))
        .catch((error: unknown) => {
          console.warn(`[opencode-quota] quota export write failed: ${rpcErrorMessage(error)}`);
        });
    },
  );
  view.refresh();
  const interval = setInterval(view.refresh, REFRESH_INTERVAL_MS);
  const stop = props.context.data.on("session.step.ended", (event) => {
    if (props.surface === "home" || getSessionID(event) === props.sessionID) view.refresh();
  });
  onCleanup(() => {
    view.dispose();
    clearInterval(interval);
    stop();
  });
  return (
    <Show when={lines().length}>
      <box flexDirection="column">
        {lines().map((line) => (
          <text fg={props.context.theme.text.muted}>{line}</text>
        ))}
      </box>
    </Show>
  );
}

function reportFailure(error: unknown): void {
  // OpenCode answers rpc.unavailable when no server plugin registered the quota RPC here.
  const hint =
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "rpc.unavailable"
      ? " (OpenCode Quota's server plugin is not loaded for this folder)"
      : "";
  console.warn(`[opencode-quota] failed to load quota: ${rpcErrorMessage(error)}${hint}`);
}

/** OpenCode's dialog widths (dialogWidth in its ui/dialog.tsx). */
const DIALOG_WIDTHS: Record<DialogSize, number> = { medium: 60, large: 88, xlarge: 116 };

function sanitizeQuotaRow(row: ReportQuotaRow): ReportQuotaRow {
  return {
    ...row,
    label: sanitizeDisplayText(row.label),
    value: sanitizeDisplayText(row.value),
    usage: row.usage === undefined ? undefined : sanitizeDisplayText(row.usage),
    reset: row.reset === undefined ? undefined : sanitizeDisplayText(row.reset),
    notes: row.notes.map(sanitizeDisplayText),
  };
}

/** A report's /quota blocks, sanitized, for layoutQuotaTables. */
function quotaBlocks(section: ReportSection): QuotaBlock[] {
  return section.blocks.flatMap((block) =>
    block.kind === "quota"
      ? [
          {
            ...block,
            provider: sanitizeDisplayText(block.provider),
            rows: block.rows.map(sanitizeQuotaRow),
          },
        ]
      : [],
  );
}

/**
 * A /quota table (see layoutQuotaTables): its title bold, like a section title, then its
 * header bold in OpenCode's primary accent, like the token tables, and its providers bold.
 * In the rows, labels, reset times, and notes are muted; bars, percents, and values base.
 */
function QuotaTableView(props: { table: QuotaTable; theme: DialogTheme }): JSX.Element {
  return (
    <box flexDirection="column">
      <text attributes={TextAttributes.BOLD} fg={props.theme.text.base}>
        {props.table.title}
      </text>
      {props.table.lines.map((line) =>
        line.style === "row" ? (
          <text fg={props.theme.text.base} wrapMode="none">
            {line.segments.map((segment) => (
              <span style={{ fg: segment.muted ? props.theme.text.muted : props.theme.text.base }}>
                {segment.text}
              </span>
            ))}
          </text>
        ) : (
          <text
            attributes={TextAttributes.BOLD}
            fg={
              line.style === "header"
                ? props.theme.text.action.primary.selected
                : props.theme.text.base
            }
            wrapMode={line.style === "header" ? "none" : undefined}
          >
            {line.segments.map((segment) => segment.text).join("")}
          </text>
        ),
      )}
    </box>
  );
}

/**
 * One block of a report. Lines, and the chat lines of /quota rows the dialog's tables do not
 * fit, and key-value rows wrap at words. A table keeps each row on one line and spans `width`
 * columns when it fits (see fitTableToWidth), with the header row bold in OpenCode's primary
 * accent (its text color for a selected tab). Like OpenCode's sidebar, labels are muted and
 * values are base.
 */
function ReportBlockView(props: {
  block: ReportBlock;
  theme: DialogTheme;
  width: number;
}): JSX.Element {
  const block = props.block;
  if (block.kind === "lines" || block.kind === "quota") {
    return <text fg={props.theme.text.muted}>{sanitizeDisplayText(block.lines.join("\n"))}</text>;
  }
  if (block.kind === "kv") {
    return (
      <box flexDirection="column">
        {block.rows.map(({ value, ...key }) =>
          value === undefined ? (
            <text fg={props.theme.text.muted}>{sanitizeDisplayText(renderKvRow(key))}</text>
          ) : (
            <text fg={props.theme.text.muted}>
              {sanitizeDisplayText(renderKvRow({ ...key, trailingColon: true }))}
              <span style={{ fg: props.theme.text.base }}> {sanitizeDisplayText(value)}</span>
            </text>
          ),
        )}
      </box>
    );
  }
  // Read in the JSX, so the table is laid out again when the terminal is resized.
  const table = () =>
    fitTableToWidth({
      headers: block.headers.map(sanitizeDisplayText),
      fullHeaders: block.fullHeaders?.map(sanitizeDisplayText),
      rows: block.rows.map((row) => row.map(sanitizeDisplayText)),
      aligns: block.aligns,
      width: props.width,
    });
  return (
    <box flexDirection="column">
      <text
        attributes={TextAttributes.BOLD}
        fg={props.theme.text.action.primary.selected}
        wrapMode="none"
      >
        {table().header}
      </text>
      {table().rows.map((row) => (
        <text fg={props.theme.text.base} wrapMode="none">
          {row}
        </text>
      ))}
    </box>
  );
}

/**
 * Draws a report document's sections with the same spacing as its plain text: one blank row
 * between the sections and between the blocks of a section, and a section title directly
 * above its first block. Section titles are bold. A /quota report's provider sections come
 * first; when their rows fit the dialog's tables (see layoutQuotaTables), the tables take
 * their place. The dialog shows the heading's subtitle under its own title, so the heading
 * line is left out.
 */
function ReportDocumentView(props: {
  document: ReportDocument;
  theme: DialogTheme;
  width: number;
}): JSX.Element {
  const sections = renderableSections(props.document);
  const blocks = sections.flatMap(quotaBlocks);
  // Read in the JSX, so the tables are laid out again when the terminal is resized.
  const tables = () => (blocks.length > 0 ? layoutQuotaTables(blocks, props.width) : undefined);
  return (
    <box flexDirection="column" gap={1}>
      {[
        ...(tables() ?? []).map((table) => <QuotaTableView table={table} theme={props.theme} />),
        ...sections
          .filter((section) => !tables() || !section.blocks.some((block) => block.kind === "quota"))
          .map((section) => (
            <box flexDirection="column">
              {section.title ? (
                <text attributes={TextAttributes.BOLD} fg={props.theme.text.base}>
                  {sanitizeDisplayText(section.title)}
                </text>
              ) : null}
              <box flexDirection="column" gap={1}>
                {section.blocks.map((block) => (
                  <ReportBlockView block={block} theme={props.theme} width={props.width} />
                ))}
              </box>
            </box>
          )),
      ]}
    </box>
  );
}

/**
 * Shows command output like OpenCode's alert dialog, but inside a scrollbox so long
 * reports (/quota_status, /tokens_*) stay reachable. The mouse wheel scrolls the box;
 * arrows, PageUp/PageDown, and Home/End scroll it from the keyboard. Esc is handled by
 * the host dialog; Enter and the ok/esc labels close it.
 */
function QuotaOutputDialog(props: {
  context: TuiContext;
  title: string;
  document: ReportDocument;
  size: DialogSize;
}): JSX.Element {
  const theme = () => props.context.theme.surface("dialog");
  const dimensions = useTerminalDimensions();
  // OpenCode's dialog is its size's width, at most the terminal width minus 2. Inside it
  // come this box's paddings (2 + 2) and one column for the scrollbox's scrollbar, which
  // shows when the report is taller than the box.
  const tableWidth = () => Math.min(DIALOG_WIDTHS[props.size], dimensions().width - 2) - 4 - 1;
  const subtitle = props.document.heading?.subtitle;
  // The host dialog starts a quarter of the way down the terminal. The remaining
  // 8 rows cover the title, ok button, paddings, gaps, and one spare row; the subtitle
  // takes one more.
  const maxHeight = () =>
    Math.max(1, Math.floor(dimensions().height * 0.75) - 8 - (subtitle ? 1 : 0));
  let scroll: ScrollBoxRenderable | undefined;
  const close = () => props.context.ui.dialog.clear();

  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: "Close", group: "Dialog", run: close },
      { bind: "up", title: "Scroll up", group: "Dialog", run: () => scroll?.scrollBy(-1) },
      { bind: "down", title: "Scroll down", group: "Dialog", run: () => scroll?.scrollBy(1) },
      {
        bind: "pageup",
        title: "Scroll up one page",
        group: "Dialog",
        run: () => scroll?.scrollBy(-maxHeight()),
      },
      {
        bind: "pagedown",
        title: "Scroll down one page",
        group: "Dialog",
        run: () => scroll?.scrollBy(maxHeight()),
      },
      { bind: "home", title: "Scroll to top", group: "Dialog", run: () => scroll?.scrollTo(0) },
      {
        bind: "end",
        title: "Scroll to bottom",
        group: "Dialog",
        run: () => scroll?.scrollTo(scroll.scrollHeight),
      },
    ],
  }));

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme().text.base}>
            {props.title}
          </text>
          <text fg={theme().text.muted} onMouseUp={close}>
            esc
          </text>
        </box>
        {subtitle ? <text fg={theme().text.muted}>{sanitizeDisplayText(subtitle)}</text> : null}
      </box>
      <box paddingBottom={1}>
        <scrollbox
          ref={(element: ScrollBoxRenderable) => {
            scroll = element;
          }}
          maxHeight={maxHeight()}
        >
          <ReportDocumentView document={props.document} theme={theme()} width={tableWidth()} />
        </scrollbox>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme().background.action.primary.focused}
          onMouseUp={close}
        >
          <text fg={theme().text.action.primary.focused}>ok</text>
        </box>
      </box>
    </box>
  );
}

function showQuotaOutputDialog(
  context: TuiContext,
  output: { title: string; document: ReportDocument; dialogSize: DialogSize },
): Promise<void> {
  return new Promise<void>((resolve) => {
    context.ui.dialog.show(
      () => (
        <QuotaOutputDialog
          context={context}
          title={output.title}
          document={output.document}
          size={output.dialogSize}
        />
      ),
      resolve,
    );
    context.ui.dialog.set({ size: output.dialogSize });
  });
}

/**
 * Runs a quota command from the command palette or the prompt. It opens the dialog and
 * posts no message. `typed` holds the arguments typed after the command name in the prompt.
 */
async function runQuotaCommand(
  context: TuiContext,
  command: QuotaDialogCommandId,
  sessionID: string | undefined,
  typed?: { argumentsText: string | undefined },
): Promise<void> {
  const spec = QUOTA_DIALOG_COMMANDS.find((item) => item.id === command)!;
  let argumentsText = typed?.argumentsText;
  // Only /tokens_between needs arguments; the palette asks for them.
  if (command === "tokens_between" && !typed) {
    const value = await context.ui.dialog.prompt({
      title: spec.title,
      placeholder: "YYYY-MM-DD YYYY-MM-DD",
    });
    if (value === undefined) return;
    argumentsText = value.trim() || undefined;
  }

  try {
    const result = await quotaRpc(context).command(
      { command, arguments: argumentsText, sessionID },
      quotaRpcOptions(context),
    );
    if (result.state === "noop") return;
    await showQuotaOutputDialog(context, {
      title: result.title,
      document: result.document,
      dialogSize: result.dialogSize,
    });
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      title: "OpenCode Quota",
      message: sanitizeDisplayText(rpcErrorMessage(error)),
    });
  }
}

/**
 * Quota slash commands that reach the server (from Web or Desktop, queued in the TUI, or
 * typed in "inline" mode) post the report into the chat as a pending inbox item. When a
 * report arrives for the session on screen, tuiCommandDisplay decides what the TUI shows: "dialog" opens the report in the dialog and cancels the pending
 * item, so no chat message remains; "inline" leaves the report in the chat.
 * A command sent from Home creates its session, and OpenCode opens that session before the
 * server runs the command, so its report also arrives for the session on screen.
 * The TUI cannot tell which client typed the command, so in "dialog" mode it also removes a
 * report that Web or Desktop requested for the same session while the TUI shows it.
 */
async function showPostedQuotaReport(context: TuiContext, event: TuiEvent): Promise<void> {
  const sessionID = getSessionID(event);
  if (!sessionID || sessionID !== getRouteSessionID(context)) return;
  const inboxID = event.data?.inboxID;
  const item = event.data?.item as
    | { type?: string; payload?: { text?: unknown; metadata?: Record<string, unknown> } }
    | undefined;
  if (typeof inboxID !== "string") return;
  if (item?.type !== "user" || typeof item.payload?.text !== "string") return;
  const report = readQuotaReportMetadata(item.payload.metadata);
  if (!report) return;
  const spec = QUOTA_DIALOG_COMMANDS.find((candidate) => candidate.id === report.command);
  if (!spec) return;
  const config = await loadConfig(quotaClient(context), undefined, {
    configRootDir: quotaRoots(context).configRoot,
  });
  if (config.tuiCommandDisplay !== "dialog") return;
  // Cancelling deletes the pending item before it becomes a stored message, the same
  // request the TUI sends when the user deletes a pending prompt.
  void context.client.session.inbox.cancel({ sessionID, inboxID }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[opencode-quota] failed to remove the quota report from the chat: ${message}`);
  });
  void showQuotaOutputDialog(context, {
    title: report.title,
    document: report.document,
    dialogSize: spec.dialogSize,
  });
}

function getRouteSessionID(context: TuiContext): string | undefined {
  const route = context.ui.router.current();
  return route.type === "session" ? route.sessionID : undefined;
}

function registerQuotaCommands(context: TuiContext): void {
  context.keymap.layer(() => ({
    mode: "global",
    commands: QUOTA_DIALOG_COMMANDS.map((spec) => ({
      id: `quota.${spec.id}`,
      title: spec.title,
      group: "OpenCode Quota",
      // No slash entry: the server plugin registers the "/" commands, so each is listed once.
      palette: true,
      run: () => runQuotaCommand(context, spec.id, getRouteSessionID(context)),
    })),
  }));
}

/**
 * Runs typed quota slash commands in the TUI. On Enter, before OpenCode submits the prompt,
 * a prompt that holds exactly a quota command is cleared and the command opens its dialog.
 * So the report never shows in the chat, and on Home no session is created for it.
 * Everything else, and every command in "inline" mode, goes on to OpenCode's submit, and
 * the server command posts the report as before.
 * The layer has no mode, so it is off while the "/" list or a dialog is open. tuiCommandDisplay
 * must be known when Enter is pressed, so it is read at start and again after each typed
 * quota command. Until the first read finishes, typed commands follow the default, "dialog".
 */
function registerTypedQuotaCommands(context: TuiContext): void {
  let commandDisplay: TuiCommandDisplay | undefined;
  const readCommandDisplay = () => {
    void loadConfig(quotaClient(context), undefined, {
      configRootDir: quotaRoots(context).configRoot,
    })
      .then((config) => {
        commandDisplay = config.tuiCommandDisplay;
      })
      .catch(reportFailure);
  };
  readCommandDisplay();
  context.keymap.layer(() => ({
    // Above OpenCode's textarea layer, which submits the prompt on Enter.
    priority: 1,
    commands: [
      {
        bind: "return",
        // Synchronous on purpose: a returned promise counts as handled.
        run: () => {
          const editor = context.renderer.currentFocusedEditor;
          const typed = editor ? parseQuotaSlashCommand(editor.plainText) : undefined;
          if (!editor || !typed) return false;
          const display = commandDisplay;
          readCommandDisplay();
          if (display === "inline") return false;
          editor.clear();
          void runQuotaCommand(context, typed.command, getRouteSessionID(context), typed);
        },
      },
    ],
  }));
}

function SidebarQuotaView(props: { context: TuiContext; sessionID: string }): JSX.Element {
  const [open, setOpen] = createSignal(true);
  const [quota, setQuota] = createSignal<
    { message: string; duration: number; activeProviderCount: number } | undefined
  >(undefined);
  const lines = () => quota()?.message.split("\n") ?? [];
  const expandable = () => lines().length > 2;
  const view = createViewRefresh(
    () => getQuotaMessage(props.context, props.sessionID, "sidebar"),
    setQuota,
  );
  view.refresh();
  const interval = setInterval(view.refresh, REFRESH_INTERVAL_MS);
  const unsubscribe = props.context.data.on("session.step.ended", (event) => {
    if (getSessionID(event) === props.sessionID) view.refresh();
  });
  onCleanup(() => {
    view.dispose();
    clearInterval(interval);
    unsubscribe();
  });

  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => expandable() && setOpen((value) => !value)}
      >
        <Show when={expandable()}>
          <text fg={props.context.theme.text.base}>{open() ? "▼" : "▶"}</text>
        </Show>
        <text fg={props.context.theme.text.base}>
          <b>Quota</b>
          <Show when={expandable() && !open() && quota()?.activeProviderCount}>
            {(count: () => number) => ` (${count()} active)`}
          </Show>
        </text>
      </box>
      <Show
        when={quota()}
        fallback={<text fg={props.context.theme.text.muted}>No quota data available</text>}
      >
        <Show when={!expandable() || open()}>
          {lines().map((line) =>
            // Provider headers such as "[Copilot] (individual)" are bold, like section titles.
            line.startsWith("[") ? (
              <text fg={props.context.theme.text.base} wrapMode="none">
                <b>{line}</b>
              </text>
            ) : (
              <text fg={props.context.theme.text.muted} wrapMode="none">
                {line || " "}
              </text>
            ),
          )}
        </Show>
      </Show>
    </box>
  );
}

const plugin = Plugin.define({
  id: "opencode-quota-gui.tui",
  setup(context) {
    const api = context as unknown as TuiContext;
    let disposeEvents: (() => void) | undefined;
    const questionToolCalls = new Set<string>();
    const disposeApp = api.ui.slot({
      append: "app",
      render: () => {
        // OpenCode mounts this slot again when it reconnects to its server, which can also
        // happen right after it starts. Leaving a mount drops its keymap layers and event
        // listeners, so each mount replaces the listeners and registers everything again.
        disposeEvents?.();
        registerQuotaCommands(api);
        registerTypedQuotaCommands(api);
        const trigger = (event: TuiEvent, reason: "idle" | "compacted" | "question") => {
          const sessionID = getSessionID(event);
          if (!sessionID) return;
          // As in v4, subagent (child) sessions never show quota toasts.
          if (api.data.session.get(sessionID)?.parentID) return;
          void getQuotaMessage(api, sessionID, reason)
            .then((quota) => {
              if (!quota) return;
              api.ui.toast.show({
                variant: "info",
                title: "OpenCode Quota",
                message: quota.message,
                duration: quota.duration,
              });
              if (quota.resetNotification) {
                api.ui.toast.show({
                  variant: "success",
                  title: "Quota available",
                  message: sanitizeDisplayText(quota.resetNotification),
                  duration: quota.duration,
                });
              }
            })
            .catch(reportFailure);
        };
        const onExecutionSucceeded = api.data.on("session.execution.succeeded", (event) =>
          trigger(event, "idle"),
        );
        const onCompacted = api.data.on("session.compaction.ended", (event) =>
          trigger(event, "compacted"),
        );
        const onQuestionStarted = api.data.on("session.tool.input.started", (event) => {
          const id = event.data?.id;
          if (event.data?.name === "question" && typeof id === "string") {
            questionToolCalls.add(id);
          }
        });
        const onQuestionSucceeded = api.data.on("session.tool.success", (event) => {
          const id = event.data?.id;
          if (typeof id === "string" && questionToolCalls.delete(id)) trigger(event, "question");
        });
        const onQuestionFailed = api.data.on("session.tool.failed", (event) => {
          const id = event.data?.id;
          if (typeof id === "string") questionToolCalls.delete(id);
        });
        const onInboxEnqueued = api.data.on("session.inbox.enqueued", (event) => {
          void showPostedQuotaReport(api, event).catch(reportFailure);
        });
        disposeEvents = () => {
          onExecutionSucceeded();
          onCompacted();
          onQuestionStarted();
          onQuestionSucceeded();
          onQuestionFailed();
          onInboxEnqueued();
          questionToolCalls.clear();
        };
        return null;
      },
    });
    const disposeSidebar = api.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarQuotaView context={api} sessionID={props.sessionID} />,
    });
    const disposePrompt = api.ui.slot({
      append: "prompt.footer",
      render: (props) => <QuotaFooter context={api} sessionID={props.sessionID} surface="prompt" />,
    });
    const disposeHome = api.ui.slot({
      append: "home.footer.status",
      render: () => <QuotaFooter context={api} surface="home" />,
    });
    return () => {
      disposeEvents?.();
      disposeApp();
      disposeSidebar();
      disposePrompt();
      disposeHome();
    };
  },
});

export default plugin;
