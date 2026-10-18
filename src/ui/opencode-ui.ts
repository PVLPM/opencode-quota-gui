/**
 * The one and only `@opencode/ui` importer in the GUI (design spec §11.1, R36).
 *
 * Adoption starts with `/button`, `/text-input` and `/styles`; the wrapper may
 * re-export further public components later without changing this boundary.
 * Nothing else under `src/ui/` may import the package — `tests/gui.opencode-ui.test.ts`
 * enforces the single-importer rule, so swapping the library for local
 * primitives stays a one-file change.
 */
import "@opencode/ui/styles";

export { Button, type ButtonProps } from "@opencode/ui/button";
export { TextInput, type TextInputProps } from "@opencode/ui/text-input";
