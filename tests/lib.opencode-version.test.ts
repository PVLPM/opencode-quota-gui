import { describe, expect, it } from "vitest";

import {
  detectOpenCodeMajor,
  detectOpenCodeVersion,
  isPreNativeGuiVersion,
  parseOpenCodeMajor,
  parseOpenCodeVersion,
  supportsNativeGui,
} from "../src/lib/opencode-version.js";

describe("OpenCode version detection", () => {
  it.each([
    ["1.18.32\n", 1],
    ["opencode v2.0.16\n", 2],
    ["opencode v2.1.0-beta.1", 2],
    ["v1.0.0", 1],
    ["0.15.8", undefined],
    ["opencode v3.0.0", undefined],
    ["", undefined],
    ["command not found", undefined],
  ])("parses %j as %j", (output, major) => {
    expect(parseOpenCodeMajor(output)).toBe(major);
  });

  it.each([
    ["1.18.32\n", { major: 1, minor: 18, patch: 32 }],
    ["opencode v2.0.16\n", { major: 2, minor: 0, patch: 16 }],
    ["v2.2.0-beta.1", { major: 2, minor: 2, patch: 0 }],
    ["opencode v2.3.5+deadbeef", { major: 2, minor: 3, patch: 5 }],
    ["0.15.8", { major: 0, minor: 15, patch: 8 }],
    ["", undefined],
    ["dev", undefined],
    ["opencode latest", undefined],
  ])("parses the full numeric version from %j", (output, version) => {
    expect(parseOpenCodeVersion(output)).toEqual(version);
  });

  it("runs the version command through the given runner", async () => {
    expect(await detectOpenCodeMajor(async () => "1.18.32\n")).toBe(1);
    expect(await detectOpenCodeMajor(async () => "opencode v2.0.16\n")).toBe(2);
    expect(await detectOpenCodeVersion(async () => "opencode v2.2.0\n")).toEqual({
      major: 2,
      minor: 2,
      patch: 0,
    });
  });

  it("returns undefined when the command fails or times out", async () => {
    const missing = Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
    expect(await detectOpenCodeMajor(async () => Promise.reject(missing))).toBeUndefined();
    expect(await detectOpenCodeVersion(async () => Promise.reject(missing))).toBeUndefined();
  });

  it.each([
    ["2.0.16", false],
    ["2.1.4", false],
    ["2.2.0", true],
    ["2.2.5", true],
    ["2.3.0", true],
    ["2.2.0-beta.1", true],
    ["2.2.0-rc.1+build.7", true],
    ["1.18.32", false],
    ["3.0.0", true],
    ["", false],
    ["garbage", false],
    [undefined, false],
  ])("reports supportsNativeGui(%j) as %j", (version, supported) => {
    expect(supportsNativeGui(version)).toBe(supported);
  });

  it.each([
    ["2.0.16", true],
    ["2.1.4", true],
    ["2.2.0", false],
    ["2.2.5", false],
    ["2.2.0-beta.1", false],
    ["", false],
    ["garbage", false],
    [undefined, false],
  ])("reports isPreNativeGuiVersion(%j) as %j", (version, legacy) => {
    expect(isPreNativeGuiVersion(version)).toBe(legacy);
  });
});
