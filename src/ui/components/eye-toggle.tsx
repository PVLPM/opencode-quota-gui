import type { JSX } from "solid-js";
import { createSignal } from "solid-js";
import { EyeIcon, EyeOffIcon } from "./icons";

/**
 * Visibility eye toggle (design spec §10, R33 / invariant 8).
 *
 * A 32px hit area with `aria-pressed` and a title-based tooltip. The toggle is
 * optimistic — the row or card hides immediately — and reverts if the write
 * fails, because visibility never changes a payload, only presentation.
 */
export function EyeToggle(props: {
  pressed: boolean;
  label: string;
  title: string;
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

  return (
    <button
      type="button"
      class="qg-eye"
      aria-pressed={props.pressed ? "true" : "false"}
      aria-label={props.label}
      title={failed() ? `${props.title} — the change was not saved` : props.title}
      disabled={pending()}
      onClick={() => {
        void toggle();
      }}
    >
      {props.pressed ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}
