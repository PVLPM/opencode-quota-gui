import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("places the native-only diagnostics action at the bottom of About", () => {
  const settings = readFileSync("src/ui/views/settings.tsx", "utf8");
  const about = readFileSync("src/ui/components/build-info.tsx", "utf8");
  const native = readFileSync("src/native/settings-page.tsx", "utf8");
  const route = readFileSync("src/ui/routes.tsx", "utf8");
  expect(settings).toContain("<BuildAbout>{props.aboutAction}</BuildAbout>");
  expect(about).toMatch(/Contract.*[\s\S]*props\.children[\s\S]*<\/section>/);
  expect(route).toContain("aboutAction={props.aboutAction}");
  expect(native).toContain("aboutAction=");
  expect(native).toContain('name={copied() ? "check" : "copy"}');
  expect(native).not.toMatch(/qg-settings-page__status[\s\S]{0,150}Copy diagnostics/);
});

it("lets the Desktop settings panel own scrolling while the save bar sticks", () => {
  const css = readFileSync("src/native/native.css", "utf8");
  expect(css).toMatch(/\.qg-native\.qg-settings-page\s*\{[^}]*min-height:\s*100%/s);
  expect(css).toMatch(
    /\.qg-native\.qg-settings-page\s+\.qg-settings__scroll\s*\{[^}]*overflow:\s*visible/s,
  );
  expect(css).toMatch(
    /\.qg-native\.qg-settings-page\s+\.qg-savebar\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0/s,
  );
});

it("places native route indicators on the tab boundary without vertical offsets", () => {
  const css = readFileSync("src/native/native.css", "utf8");
  expect(css).toMatch(/\.qg-panel-root \.qg-frame > \.qg-topbar\s*\{[^}]*padding-block:\s*0/s);
  expect(css).toMatch(
    /\.qg-panel-root \.qg-frame-tab:not\(\.qg-analytics-tabs\)[^{]*\{[^}]*border-bottom:\s*1px solid/s,
  );
  expect(css).toMatch(
    /\.qg-panel-root \.qg-analytics-tabs a\[aria-current="page"\][^{]*\{[^}]*border-bottom-color:/s,
  );
  expect(css).toMatch(/\.qg-panel-root \.qg-frame-tab::after,[^{]*\{[^}]*display:\s*none/s);
  expect(css).not.toMatch(/bottom:\s*-9px/);
});

it("provides the host UI to the dashboard panel", () => {
  const source = readFileSync("src/native/gui.tsx", "utf8");
  expect(source).toMatch(/<NativeUiProvider ui=\{ctx\.ui\}>\s*<DashboardPanel/s);
});

it("mirrors the Web segmented control geometry and keeps range labels intact", () => {
  const css = readFileSync("src/native/native.css", "utf8");
  expect(css).toMatch(
    /:where\(\.qg-native\) \.qg-segmented\s*\{[^}]*width:\s*232px;[^}]*height:\s*28px/s,
  );
  expect(css).toMatch(
    /:where\(\.qg-native\) \.qg-segmented__item\s*\{[^}]*flex:\s*1 1 0;[^}]*height:\s*28px/s,
  );
  expect(css).toMatch(
    /\.qg-panel-root \.qg-range\[data-slot="segmented-control-v2"\]\s*\{[^}]*width:\s*256px/s,
  );
  expect(css).toMatch(
    /\.qg-panel-root \.qg-range \[data-slot="segmented-control-v2-item"\]\s*\{[^}]*white-space:\s*nowrap/s,
  );
});

it("keeps the range selection outline inside its horizontal scroller", () => {
  const css = readFileSync("src/native/native.css", "utf8");
  expect(css).toMatch(
    /\.qg-panel-root \.qg-range\[data-slot="segmented-control-v2"\]\s*\{[^}]*overflow-x:\s*auto/s,
  );
  expect(css).toMatch(
    /\.qg-panel-root \.qg-range \[data-slot="segmented-control-v2-item"\]\[data-selected\]\s*\{[^}]*box-shadow:\s*inset 0 0 0 0\.5px/s,
  );
  expect(css).toMatch(
    /\.qg-panel-root \.qg-range \[data-slot="segmented-control-v2-item"\]:focus-visible\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px/s,
  );
});
