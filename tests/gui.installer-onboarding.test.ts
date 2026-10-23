import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInitInstaller } from "../src/lib/init-installer.js";
import { parseJsonOrJsonc } from "../src/lib/jsonc.js";

vi.mock("../src/lib/opencode-version.js", () => ({ detectOpenCodeMajor: async () => 2 }));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "quota-onboarding-"));
  dirs.push(dir);
  return dir;
}
function adapter(manual = false, apply = true) {
  const transcript: string[] = [];
  const prompts = {
    intro: (message: string) => transcript.push(message),
    outro: (message: string) => transcript.push(message),
    select: async ({ message, initialValue }: { message: string; initialValue?: string }) => {
      transcript.push(message);
      if (/interfaces do you use/.test(message)) return "web";
      if (/Where should/.test(message)) return "project";
      if (/providers be selected/.test(message)) return manual ? "manual" : "auto";
      return initialValue;
    },
    multiselect: async ({ message }: { message: string }) => {
      transcript.push(message);
      return ["openai"];
    },
    confirm: async ({ message }: { message: string }) => {
      transcript.push(message);
      return apply;
    },
    isCancel: () => false,
    log: {
      info: (message: string) => transcript.push(message),
      success: (message: string) => transcript.push(message),
      error: (message: string) => transcript.push(`ERROR: ${message}`),
    },
  };
  return { prompts, transcript };
}
function installerEnv(dir: string) {
  return { OPENCODE_CONFIG_DIR: join(dir, "global-config") };
}
describe("GUI-first onboarding", () => {
  it.each([
    4144, 4251,
  ])("finishes with restart and the configured localhost GUI URL (port %s)", async (port) => {
    const dir = fixture();
    const globalDir = join(dir, "global");
    if (port !== 4144) {
      mkdirSync(join(globalDir, "opencode-quota-gui"), { recursive: true });
      writeFileSync(
        join(globalDir, "opencode-quota-gui", "config.jsonc"),
        JSON.stringify({ dashboard: { port } }),
      );
    }
    const { prompts, transcript } = adapter();
    expect(
      await runInitInstaller({ cwd: dir, env: { OPENCODE_CONFIG_DIR: globalDir }, prompts }),
    ).toBe(0);
    const outro = transcript.at(-1) ?? "";
    expect(outro).toContain(`Restart OpenCode, then open http://localhost:${port}/quota`);
    expect(outro).not.toContain(" show`");
  });
  it("notes a real legacy native plugin without treating workspace overrides as legacy", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "opencode.jsonc"), '{"plugins":["@slkiser/opencode-quota@latest"]}\n');
    const { prompts, transcript } = adapter();
    expect(await runInitInstaller({ cwd: dir, env: {}, prompts, dryRun: true })).toBe(0);
    expect(transcript.join("\n")).toContain("Legacy quota configuration detected");
    const fresh = fixture();
    const next = adapter();
    expect(
      await runInitInstaller({
        cwd: fresh,
        env: { OPENCODE_WORKSPACE: "synthetic-workspace" },
        prompts: next.prompts,
        dryRun: true,
      }),
    ).toBe(0);
    expect(next.transcript.join("\n")).not.toMatch(/legacy/i);
  });
  it("does not turn an implicit default into an explicit replacement of an existing local install", async () => {
    const dir = fixture();
    mkdirSync(join(dir, "checkout"));
    writeFileSync(join(dir, "checkout", "package.json"), '{"name":"opencode-quota-gui"}');
    const source = '{"plugins":["./checkout/dist/index.js"]}\n';
    writeFileSync(join(dir, "opencode.jsonc"), source);
    const { prompts } = adapter();
    expect(await runInitInstaller({ cwd: dir, env: installerEnv(dir), prompts })).toBe(0);
    expect(readFileSync(join(dir, "opencode.jsonc"), "utf8")).toBe(source);
  });
  it.each([
    "host",
    "quota",
  ])("preserves the existing %s JSON source when another config uses JSONC", async (kind) => {
    const dir = fixture();
    mkdirSync(join(dir, "opencode-quota"));
    const source =
      kind === "host"
        ? join(dir, "opencode.json")
        : join(dir, "opencode-quota", "quota-toast.json");
    const other =
      kind === "host"
        ? join(dir, "opencode-quota", "quota-toast.jsonc")
        : join(dir, "opencode.jsonc");
    writeFileSync(source, "{}\n");
    writeFileSync(other, "{}\n");
    const { prompts } = adapter();
    expect(await runInitInstaller({ cwd: dir, env: installerEnv(dir), prompts })).toBe(0);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(`${source}c`)).toBe(false);
  });
  it("asks only scope, providers, percentages and apply, with GUI-first opt-outs", async () => {
    const dir = fixture();
    const { prompts, transcript } = adapter();
    expect(await runInitInstaller({ cwd: dir, env: installerEnv(dir), prompts })).toBe(0);
    expect(transcript[0]).toBe("Configure OpenCode Quota GUI");
    const questions = transcript.filter((line) => line.endsWith("?"));
    expect(questions).toEqual([
      "Where should OpenCode Quota GUI be configured?",
      "How should pre-configured providers be selected?",
      "What should quota percentages show?",
      "Apply changes?",
    ]);
    expect(transcript.join("\n")).not.toMatch(
      /@slkiser|legacy|Which OpenCode interfaces|TUI surfaces|Maintainer announcements/i,
    );
    expect(transcript).toContain("Preview changes");
    const raw = readFileSync(
      join(dir, "global-config", "opencode-quota-gui", "config.jsonc"),
      "utf8",
    );
    expect(parseJsonOrJsonc(raw, true)).toMatchObject({
      enableToast: false,
      tuiSidebarPanel: { enabled: false },
      tuiCompactStatus: { enabled: false },
      maintainerAnnouncements: { enabled: false },
    });
  });
  it("asks manual providers only conditionally and cancellation leaves no files", async () => {
    const dir = fixture();
    const { prompts, transcript } = adapter(true, false);
    expect(await runInitInstaller({ cwd: dir, env: {}, prompts })).toBe(0);
    expect(transcript).toContain("Which pre-configured providers should be tracked?");
    expect(existsSync(join(dir, "opencode.jsonc"))).toBe(false);
  });
  it("preserves an upstream quota-toast source byte-for-byte", async () => {
    const dir = fixture();
    mkdirSync(join(dir, "opencode-quota"));
    const source =
      '{\n "enableToast": true,\n "tuiSidebarPanel": { "enabled": true, "custom": 7 },\n "tuiCompactStatus": { "enabled": true, "sessionPrompt": false, "maxWidth": 40 },\n "tuiCommandDisplay": "inline",\n "maintainerAnnouncements": { "enabled": true, "home": false }\n}\n';
    writeFileSync(join(dir, "opencode-quota", "quota-toast.jsonc"), source);
    const { prompts } = adapter();
    expect(await runInitInstaller({ cwd: dir, env: installerEnv(dir), prompts })).toBe(0);
    expect(readFileSync(join(dir, "opencode-quota", "quota-toast.jsonc"), "utf8")).toBe(source);
    expect(existsSync(join(dir, "global-config", "opencode-quota-gui", "config.jsonc"))).toBe(true);
  });
  it("detects actual legacy config, previews migration and preserves both entries", async () => {
    const dir = fixture();
    const source =
      '{"plugin":["@slkiser/opencode-quota@latest"],"experimental":{"quotaToast":{"enableToast":true}}}\n';
    writeFileSync(join(dir, "opencode.json"), source);
    const { prompts, transcript } = adapter();
    expect(
      await runInitInstaller({
        cwd: dir,
        env: installerEnv(dir),
        prompts,
        pluginSpec: "opencode-quota-gui@next",
      }),
    ).toBe(0);
    expect(transcript.join("\n")).toContain("Legacy quota configuration detected");
    expect(transcript.join("\n")).not.toContain("@slkiser/opencode-quota@latest");
    const host = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
    expect(host.experimental).toEqual(JSON.parse(source).experimental);
    expect(host.plugin).toEqual(["@slkiser/opencode-quota@latest"]);
    expect(host.plugins).toEqual(["opencode-quota-gui@next"]);
    expect(existsSync(join(dir, "opencode.jsonc"))).toBe(false);
  });
});
