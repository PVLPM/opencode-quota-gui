/**
 * Native GUI primitives for the Desktop window (Stage 4).
 *
 * `src/ui/opencode-ui.ts` is the product's one replaceability seam. The web
 * build fills it with `@opencode/ui`; the native build aliases it to this file
 * because the Desktop host does not provide that package to plugin bundles.
 *
 * These are not a second design system: every visual value still comes from
 * the shared product stylesheet, which is injected into the window unchanged.
 * The elements below mirror the library's public contract closely enough for
 * the shared feature components (`Icon`, `Tooltip`, the popover loader and the
 * form primitives) to render and behave as they do on the web, while the
 * library-only CSS (tokens, bubbles, segmented control) is restated once, at
 * zero specificity, in `native.css`.
 */
import type { Component, JSX } from "solid-js";
import {
  createContext,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
  splitProps,
  useContext,
} from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { type Placement, placePopover } from "./popover-position";

/* ------------------------------------------------------------------ icons */

interface IconArtwork {
  viewBox: string;
  body: string;
}

/**
 * The library's artwork for every glyph the shared product components use, plus
 * its unknown-name fallback. Paths are copied verbatim from the pinned
 * `@opencode/ui` artwork catalog; the sprite mechanism is replaced by inline
 * markup so the plugin does not touch the host document.
 */
const ICONS: Readonly<Record<string, IconArtwork>> = {
  info: {
    viewBox: "0 0 16 16",
    body: '<g transform="translate(2 2)"><path d="M12 12H0V0H12V12ZM1 1V11H11V1H1ZM6.5791 4.81641V9.37207H5.5791V5.81641H4.46777V4.81641H6.5791ZM6.85645 2.62891V3.62891H5.30078V2.62891H6.85645Z" fill="currentColor"/></g>',
  },
  plus: {
    viewBox: "0 0 16 16",
    body: '<path d="M8 2.88867V13.1109" stroke="currentColor" stroke-linejoin="round"/><path d="M2.88867 8H13.1109" stroke="currentColor" stroke-linejoin="round"/>',
  },
  "settings-gear": {
    viewBox: "0 0 16 16",
    body: '<path d="M7.99998 1.3335L14 4.66683V11.3335L7.99998 14.6668L2 11.3335V4.66683L7.99998 1.3335Z" stroke="currentColor"/><path d="M9.99998 8.00016C9.99998 9.10476 9.10458 10.0002 7.99998 10.0002C6.89538 10.0002 5.99998 9.10476 5.99998 8.00016C5.99998 6.89556 6.89538 6.00016 7.99998 6.00016C9.10458 6.00016 9.99998 6.89556 9.99998 8.00016Z" stroke="currentColor"/>',
  },
  "outline-eye": {
    viewBox: "0 0 20 20",
    body: '<path d="M2.5 10s3.33-5.42 7.5-5.42S17.5 10 17.5 10s-3.33 5.42-7.5 5.42S2.5 10 2.5 10Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.5" stroke="currentColor"/>',
  },
  "outline-eye-slash": {
    viewBox: "0 0 20 20",
    body: '<path d="M2.5 10s3.33-5.42 7.5-5.42S17.5 10 17.5 10s-3.33 5.42-7.5 5.42S2.5 10 2.5 10Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.5" stroke="currentColor"/><path d="M3 3 17 17" stroke="currentColor" stroke-linecap="round"/>',
  },
};

export interface IconProps extends Omit<JSX.SvgSVGAttributes<SVGSVGElement>, "name" | "size"> {
  name: string;
  size?: "small" | "normal" | "large";
}

export function Icon(props: IconProps): JSX.Element {
  const [local, rest] = splitProps(props, ["name", "size"]);
  const artwork = () => ICONS[local.name] ?? ICONS.plus;
  const pixels = () => (local.size === "small" ? 14 : local.size === "large" ? 20 : 16);
  return (
    <svg
      {...rest}
      width={pixels()}
      height={pixels()}
      viewBox={artwork().viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={rest["aria-hidden"] ?? "true"}
      innerHTML={artwork().body}
    />
  );
}

/* --------------------------------------------------------- shared geometry */

type AnchorSignal = () => HTMLElement | undefined;

interface AnchoredOptions {
  open: () => boolean;
  anchor: AnchorSignal;
  content: AnchorSignal;
  placement: () => Placement;
  gutter: () => number;
  shift: () => number;
}

/**
 * Positions one fixed portal next to its anchor. It re-measures on open,
 * on scroll (capture, so nested scrollers count), on resize and whenever the
 * content changes size, and reports a height cap only when the viewport is
 * genuinely too short for the content.
 */
function useAnchoredPortal(options: AnchoredOptions): {
  left: () => number;
  top: () => number;
  maxHeight: () => number | undefined;
  ready: () => boolean;
} {
  const [left, setLeft] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const [maxHeight, setMaxHeight] = createSignal<number>();
  const [ready, setReady] = createSignal(false);

  function measure(): void {
    const anchor = options.anchor();
    const content = options.content();
    if (!anchor || !content) return;
    const anchorRect = anchor.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const result = placePopover({
      anchor: {
        left: anchorRect.left,
        top: anchorRect.top,
        width: anchorRect.width,
        height: anchorRect.height,
      },
      content: { width: contentRect.width, height: contentRect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      placement: options.placement(),
      gutter: options.gutter(),
      shift: options.shift(),
    });
    setLeft(result.left);
    setTop(result.top);
    setMaxHeight(result.maxHeight);
    setReady(true);
  }

  createEffect(() => {
    if (!options.open()) {
      setReady(false);
      return;
    }
    // Track the elements and the placement inputs so a ref or a flip re-measures.
    options.anchor();
    options.content();
    options.placement();
    measure();

    const onViewportChange = () => measure();
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => measure());
    const content = options.content();
    if (content !== undefined) observer?.observe(content);
    onCleanup(() => {
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
      observer?.disconnect();
    });
  });

  return { left, top, maxHeight, ready };
}

/** Closes on Escape and on a pointer press outside both the anchor and content. */
function useDismiss(options: {
  open: () => boolean;
  anchor: AnchorSignal;
  content: AnchorSignal;
  onDismiss: () => void;
}): void {
  createEffect(() => {
    if (!options.open()) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (options.content()?.contains(target) === true) return;
      if (options.anchor()?.contains(target) === true) return;
      options.onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      options.onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    });
  });
}

/* ---------------------------------------------------------------- tooltips */

export interface TooltipProps {
  value: JSX.Element;
  appearance?: "standard" | "compact" | "large";
  class?: string;
  contentClass?: string;
  contentStyle?: JSX.CSSProperties;
  inactive?: boolean;
  forceOpen?: boolean;
  triggerTabIndex?: number;
  placement?: Placement;
  children: JSX.Element;
}

const TOOLTIP_OPEN_DELAY_MS = 400;

/**
 * Hover/focus disclosure for long backend sentences and navigation labels.
 * `forceOpen` makes it controlled, exactly like the library the web build uses
 * (the shell drives the nav tooltip from local state).
 */
export function Tooltip(props: TooltipProps): JSX.Element {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [content, setContent] = createSignal<HTMLElement>();
  const [hovered, setHovered] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const panelId = createUniqueId();
  let delayedClose: ReturnType<typeof setTimeout> | undefined;
  let delayedOpen: ReturnType<typeof setTimeout> | undefined;

  const controlled = () => props.forceOpen !== undefined;
  const open = () => props.forceOpen ?? (hovered() || focused());

  function clearDelays(): void {
    if (delayedOpen !== undefined) clearTimeout(delayedOpen);
    if (delayedClose !== undefined) clearTimeout(delayedClose);
    delayedOpen = undefined;
    delayedClose = undefined;
  }

  function close(): void {
    clearDelays();
    setHovered(false);
    setFocused(false);
  }

  onCleanup(clearDelays);

  const anchored = useAnchoredPortal({
    open,
    anchor,
    content,
    placement: () => props.placement ?? "bottom",
    gutter: () => 4,
    shift: () => 8,
  });

  return (
    <Show when={!props.inactive} fallback={props.children}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the public tooltip's trigger is a wrapper element; its interactive child (or the wrapper's own `tabIndex`) keeps the focus and hover semantics. */}
      <div
        ref={setAnchor}
        class={props.class}
        tabIndex={props.triggerTabIndex}
        data-component="tooltip-v2-trigger"
        aria-describedby={open() ? panelId : undefined}
        onPointerEnter={() => {
          if (controlled()) return;
          if (delayedOpen !== undefined) return;
          delayedOpen = setTimeout(() => {
            delayedOpen = undefined;
            setHovered(true);
          }, TOOLTIP_OPEN_DELAY_MS);
        }}
        onPointerLeave={() => {
          if (controlled()) return;
          clearDelays();
          setHovered(false);
        }}
        onFocusIn={() => {
          if (controlled()) return;
          clearDelays();
          setFocused(true);
        }}
        onFocusOut={() => {
          if (controlled()) return;
          queueMicrotask(() => {
            const active = document.activeElement;
            if (active !== null && anchor()?.contains(active) === true) return;
            close();
          });
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      >
        {props.children}
      </div>
      <Show when={open()}>
        <Portal>
          <div
            class="qg-native qg-native-portal qg-native-tooltip"
            style={{ left: `${anchored.left()}px`, top: `${anchored.top()}px` }}
          >
            <div
              ref={setContent}
              id={panelId}
              role="tooltip"
              class={`qg-native-tooltip__bubble${
                props.contentClass === undefined ? "" : ` ${props.contentClass}`
              }`}
              data-appearance={props.appearance ?? "compact"}
              style={{
                ...props.contentStyle,
                ...(anchored.maxHeight() === undefined
                  ? {}
                  : { "max-height": `${anchored.maxHeight()}px`, overflow: "hidden" }),
              }}
            >
              {props.value}
            </div>
          </div>
        </Portal>
      </Show>
    </Show>
  );
}

/* ----------------------------------------------------------------- popover */

interface LibraryPopoverProps {
  triggerAs?: string;
  trigger?: JSX.Element;
  triggerProps?: Record<string, unknown>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: string;
  gutter?: number;
  shift?: number;
  fitViewport?: boolean;
  flip?: boolean;
  class?: string;
  children?: JSX.Element;
}

function asPlacement(value: string | undefined): Placement {
  switch (value) {
    case "bottom":
    case "bottom-start":
    case "bottom-end":
    case "top":
    case "top-start":
    case "top-end":
      return value;
    default:
      return "bottom-start";
  }
}

/**
 * The controlled disclosure behind `InteractivePopover`. The shared wrapper
 * owns hover/focus/pin policy; this supplies the same trigger, dialog role and
 * viewport-aware placement the public `Popover` does on the web.
 */
function NativePopover(props: LibraryPopoverProps): JSX.Element {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [content, setContent] = createSignal<HTMLElement>();
  const panelId = createUniqueId();
  const open = () => props.open === true;

  const anchored = useAnchoredPortal({
    open,
    anchor,
    content,
    placement: () => asPlacement(props.placement),
    gutter: () => props.gutter ?? 6,
    shift: () => props.shift ?? 8,
  });

  useDismiss({
    open,
    anchor,
    content,
    onDismiss: () => props.onOpenChange?.(false),
  });

  // A pinned panel that closes while focus is inside hands focus back to its
  // trigger, mirroring the library and the wrapper's re-open suppression.
  createEffect(() => {
    if (!open()) return;
    const trigger = anchor();
    const panel = content();
    onCleanup(() => {
      const active = document.activeElement;
      if (trigger === undefined || panel === undefined || active === null) return;
      if (!panel.contains(active)) return;
      trigger.focus({ preventScroll: true });
    });
  });

  return (
    <>
      <Dynamic
        component={props.triggerAs ?? "button"}
        ref={setAnchor}
        {...props.triggerProps}
        aria-expanded={open() ? "true" : "false"}
        aria-controls={open() ? panelId : undefined}
      >
        {props.trigger}
      </Dynamic>
      <Show when={open()}>
        <Portal>
          <div
            class="qg-native qg-native-portal qg-native-popover"
            style={{
              left: `${anchored.left()}px`,
              top: `${anchored.top()}px`,
              visibility: anchored.ready() ? undefined : "hidden",
            }}
          >
            <div
              ref={setContent}
              id={panelId}
              role="dialog"
              data-component="popover-content"
              class={`qg-native-popover__bubble${
                props.class === undefined ? "" : ` ${props.class}`
              }`}
              style={
                anchored.maxHeight() === undefined
                  ? undefined
                  : { "max-height": `${anchored.maxHeight()}px` }
              }
            >
              {props.children}
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}

export function loadPopover(): Promise<{ Popover: unknown }> {
  return Promise.resolve({ Popover: NativePopover as Component<LibraryPopoverProps> });
}

/* -------------------------------------------------------- form primitives */

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "primary"
    | "secondary"
    | "neutral"
    | "outline"
    | "contrast"
    | "ghost"
    | "ghost-muted"
    | "ghost-faint"
    | "danger"
    | "warning"
    | "submit"
    | "loading";
  size?: "small" | "normal" | "large";
}

export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["variant", "size", "class", "type"]);
  const variant = () => local.variant ?? "secondary";
  const size = () => local.size ?? "normal";
  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      class={`qg-button qg-button--${variant()} qg-button--${size()}${
        local.class === undefined ? "" : ` ${local.class}`
      }`}
    />
  );
}

export interface TextInputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {}

export function TextInput(props: TextInputProps): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <input {...rest} class={`qg-input${local.class === undefined ? "" : ` ${local.class}`}`} />
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  /** Matches the public Switch: keep the row's label for assistive tech only. */
  hideLabel?: boolean;
  appearance?: "standard" | "compact";
  description?: string;
  children?: JSX.Element;
}

export function Switch(props: SwitchProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked ? "true" : "false"}
      aria-label={props.label}
      class="qg-switch"
      data-appearance={props.appearance ?? "compact"}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="qg-switch__thumb" aria-hidden="true" />
      {props.hideLabel ? <span class="sr-only">{props.children}</span> : props.children}
    </button>
  );
}

interface SegmentedContextValue {
  value: () => string | undefined;
  select: (value: string) => void;
}

const SegmentedContext = createContext<SegmentedContextValue>();

export interface SegmentedControlProps {
  value?: string;
  onChange?: (value: string) => void;
  class?: string;
  "aria-label"?: string;
  children?: JSX.Element;
}

export function SegmentedControl(props: SegmentedControlProps): JSX.Element {
  return (
    <SegmentedContext.Provider
      value={{ value: () => props.value, select: (value) => props.onChange?.(value) }}
    >
      <div
        role="radiogroup"
        aria-label={props["aria-label"]}
        class={`qg-segmented${props.class === undefined ? "" : ` ${props.class}`}`}
        data-slot="segmented-control-v2"
      >
        {props.children}
      </div>
    </SegmentedContext.Provider>
  );
}

export interface SegmentedControlItemProps {
  value: string;
  children?: JSX.Element;
}

export function SegmentedControlItem(props: SegmentedControlItemProps): JSX.Element {
  const context = useContext(SegmentedContext);
  const selected = () => context?.value() === props.value;
  return (
    // biome-ignore lint/a11y/useSemanticElements: the public segmented control's item is a button with `role="radio"`; a native radio input would not render the product's `data-slot` styling or fit the library's roving-tabindex group.
    <button
      type="button"
      role="radio"
      aria-checked={selected() ? "true" : "false"}
      data-slot="segmented-control-v2-item"
      data-selected={selected() ? "" : undefined}
      class="qg-segmented__item"
      onClick={() => context?.select(props.value)}
    >
      {props.children}
    </button>
  );
}
