import { describe, expect, it } from "vitest";

const packagedPlugin = await import("../dist/index.js");

describe("plugin dist packaging", () => {
  it("can load the packaged root module", () => {
    expect(packagedPlugin.default).toMatchObject({
      id: "opencode-quota-gui",
    });
    expect(typeof packagedPlugin.default.setup).toBe("function");
  });
});
