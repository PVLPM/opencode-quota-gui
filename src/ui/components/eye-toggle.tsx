import type { JSX } from "solid-js";
import { createSignal } from "solid-js";
import { Icon } from "../opencode-ui";

/**
 * Visibility eye toggle (design spec §10, R33 / invariant 8).
 *
 * Settings-only draft control. Changes join the revision-checked settings save;
 * visibility never changes a payload or provider polling. The icon is the
 * public `outline-eye` / `outline-eye-slash` glyph; colors stay in CSS and are
 * never green — a visible eye is secondary grey, a hidden one is muted grey.
 */
export function EyeToggle(props: {
  pressed: boolean;
  label: string;
  title: string;
  disabled?: boolean;
  /** Both variants share the 28px visibility geometry; the class carries context. */
  variant?: "provider" | "row";
  onToggle: () => Promise<void>;
}): JSX.Element {
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  async function toggle(): Promise<void> {
    if (pending()) return;
    setPending(true);
    setFailed(false);
    try {
      await props.onToggle();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  const variantClass = () => (props.variant === undefined ? "" : ` qg-eye--${props.variant}`);

  return (
    <button
      type="button"
      class={`qg-eye${variantClass()}`}
      aria-pressed={props.pressed ? "true" : "false"}
      aria-label={props.label}
      title={failed() ? `${props.title} — the change was not saved` : props.title}
      disabled={props.disabled || pending()}
      onClick={() => {
        void toggle();
      }}
    >
      <Icon name={props.pressed ? "outline-eye-slash" : "outline-eye"} />
    </button>
  );
}
