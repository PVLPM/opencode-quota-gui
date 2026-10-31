/**
 * The one and only `@opencode/ui` importer in the GUI (design spec §11.1, R36).
 *
 * Adoption starts with `/button`, `/text-input` and `/styles`; the wrapper may
 * re-export further public components later without changing this boundary.
 * The interactive popover uses a browser-only dynamic loader below because its
 * Kobalte templates cannot be evaluated during server-rendered tests.
 * Nothing else under `src/ui/` may import the package — `tests/gui.opencode-ui.test.ts`
 * enforces the single-importer rule, so swapping the library for local
 * primitives stays a one-file change.
 */
import "@opencode/ui/styles";
import "@opencode/ui/styles/tokens";

/**
 * Popover ships DOM-only Kobalte templates that cannot be imported during SSR
 * tests. Keep it behind the same wrapper and load it in the browser when the
 * interactive disclosure first mounts; the server renders its accessible
 * trigger fallback instead.
 */
export function loadPopover(): Promise<{ Popover: unknown }> {
  return import("@opencode/ui/popover").then((module) => ({
    Popover: module.Popover,
  }));
}

export { Button, type ButtonProps } from "@opencode/ui/button";
export { Icon } from "@opencode/ui/icon";
export { SegmentedControl, SegmentedControlItem } from "@opencode/ui/segmented-control";
export { Switch } from "@opencode/ui/switch";
export { TextInput, type TextInputProps } from "@opencode/ui/text-input";
export { Tooltip } from "@opencode/ui/tooltip";
