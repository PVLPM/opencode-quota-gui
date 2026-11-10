import { createComponent, createEffect, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import { NativeSettingsPage } from "../src/native/settings-page";
import {
  Button,
  NativeUiProvider,
  SegmentedControl,
  SegmentedControlItem,
  Switch,
} from "../src/native/ui";

vi.mock("../src/native/dashboard-client.js", () => ({
  createNativeDashboardClient: () => ({ dispose() {} }),
}));
vi.mock("../src/native/rpc.js", () => ({ createGuiRpcCaller: () => ({}) }));
vi.mock("../src/native/settings-page-state.js", () => ({
  createSettingsPageState: () => ({
    query: { data: () => undefined, error: () => undefined },
    quota: () => undefined,
    quotaStale: () => true,
    loading: () => false,
    stale: () => true,
    connection: () => "live",
    retryable: () => true,
    retry() {},
  }),
}));

it("keeps diagnostics in About and shows copy, check and failure feedback", async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const target = document.createElement("div");
  document.body.append(target);
  const Icon = (props: { name: string }) => {
    const element = document.createElement("span");
    createEffect(() => {
      element.dataset.icon = props.name;
    });
    return element;
  };
  const dispose = render(
    () =>
      createComponent(NativeSettingsPage, {
        ctx: {
          app: { version: "2.2.1" },
          client: {},
          servers: { list: () => [] },
          ui: { Icon },
        } as never,
      }),
    target,
  );
  try {
    const about = target.querySelector('section[aria-labelledby="qg-settings-about"]')!;
    const button = about.querySelector<HTMLButtonElement>('button[aria-label="Copy diagnostics"]')!;
    expect(button.querySelector('[data-icon="copy"]')).not.toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    await vi.waitFor(() => expect(button.querySelector('[data-icon="check"]')).not.toBeNull());
    expect(document.activeElement).toBe(button);
    expect(target.textContent).toContain("Diagnostics copied to clipboard.");
    writeText.mockRejectedValueOnce(new Error("denied"));
    button.click();
    await vi.waitFor(() => expect(target.textContent).toContain("Could not copy diagnostics"));
    expect(button.querySelector('[data-icon="copy"]')).not.toBeNull();
  } finally {
    dispose();
    target.remove();
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("delegates settings controls to the host with reactive state", () => {
  const changed = vi.fn();
  const clicked = vi.fn();
  const hostSwitch = vi.fn(
    (props: { label: string; checked: boolean; onChange: (value: boolean) => void }) => {
      const button = document.createElement("button");
      button.setAttribute("aria-label", props.label);
      button.onclick = () => props.onChange(!props.checked);
      return button;
    },
  );
  const hostButton = vi.fn((props: { onClick?: (event: MouseEvent) => void }) => {
    const button = document.createElement("button");
    button.onclick = (event) => props.onClick?.(event);
    return button;
  });
  const target = document.createElement("div");
  const [checked, setChecked] = createSignal(false);
  const dispose = render(
    () =>
      createComponent(NativeUiProvider, {
        ui: { Switch: hostSwitch, Button: hostButton } as never,
        get children() {
          return [
            createComponent(Switch, {
              get checked() {
                return checked();
              },
              onChange(value) {
                changed(value);
                setChecked(value);
              },
              hideLabel: true,
              children: "Show quota",
            }),
            createComponent(Button, { variant: "contrast", onClick: clicked, children: "Save" }),
          ];
        },
      }),
    target,
  );
  expect(hostSwitch).toHaveBeenCalledOnce();
  expect(hostButton).toHaveBeenCalledOnce();
  expect(target.querySelector("button")?.getAttribute("aria-label")).toBe("Show quota");
  target.querySelector("button")?.click();
  expect(changed).toHaveBeenCalledWith(true);
  target.querySelectorAll("button")[1]?.click();
  expect(clicked).toHaveBeenCalledOnce();
  dispose();
});

it("moves selection and focus with arrow keys in segmented choices", () => {
  const [value, setValue] = createSignal("one");
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(SegmentedControl, {
        get value() {
          return value();
        },
        onChange: setValue,
        "aria-label": "Range",
        get children() {
          return [
            createComponent(SegmentedControlItem, { value: "one", children: "One" }),
            createComponent(SegmentedControlItem, { value: "two", children: "Two" }),
          ];
        },
      }),
    target,
  );
  const buttons = target.querySelectorAll("button");
  expect(buttons[0]?.tabIndex).toBe(0);
  expect(buttons[1]?.tabIndex).toBe(-1);
  buttons[0]?.focus();
  buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(value()).toBe("two");
  expect(document.activeElement).toBe(buttons[1]);
  expect(buttons[1]?.tabIndex).toBe(0);
  dispose();
  target.remove();
});

it("disables every segment and restores keyboard interaction when writable again", () => {
  const [value, setValue] = createSignal("auto");
  const [disabled, setDisabled] = createSignal(true);
  const change = vi.fn((next: string) => setValue(next));
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(SegmentedControl, {
        get value() {
          return value();
        },
        get disabled() {
          return disabled();
        },
        onChange: change,
        "aria-label": "Provider selection",
        get children() {
          return [
            createComponent(SegmentedControlItem, { value: "auto", children: "Automatic" }),
            createComponent(SegmentedControlItem, { value: "manual", children: "Manual" }),
          ];
        },
      }),
    target,
  );
  const [automatic, manual] = target.querySelectorAll("button");
  expect(target.querySelector('[role="radiogroup"]')?.getAttribute("aria-disabled")).toBe("true");
  expect(automatic?.disabled).toBe(true);
  expect(manual?.disabled).toBe(true);
  expect(automatic?.tabIndex).toBe(-1);
  automatic?.focus();
  expect(document.activeElement).not.toBe(automatic);
  manual?.click();
  automatic?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(change).not.toHaveBeenCalled();
  expect(value()).toBe("auto");
  setDisabled(false);
  expect(automatic?.disabled).toBe(false);
  expect(manual?.disabled).toBe(false);
  expect(automatic?.tabIndex).toBe(0);
  automatic?.focus();
  automatic?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(value()).toBe("manual");
  expect(document.activeElement).toBe(manual);
  dispose();
  target.remove();
});

it("preserves the real settings switch label forms", () => {
  const labels: string[] = [];
  const hostSwitch = (props: { label: string }) => {
    labels.push(props.label);
    return document.createElement("button");
  };
  const target = document.createElement("div");
  const fieldLabel = "Show runway";
  const providerLabel = "OpenAI";
  const dispose = render(
    () =>
      createComponent(NativeUiProvider, {
        ui: { Switch: hostSwitch } as never,
        get children() {
          return [
            createComponent(Switch, {
              checked: true,
              onChange: () => {},
              hideLabel: true,
              children: fieldLabel,
            }),
            createComponent(Switch, {
              checked: true,
              onChange: () => {},
              hideLabel: true,
              get children() {
                return ["Show peak and off-peak pricing for ", providerLabel, " on Quota"];
              },
            }),
          ];
        },
      }),
    target,
  );
  expect(labels).toEqual(["Show runway", "Show peak and off-peak pricing for OpenAI on Quota"]);
  dispose();
});
