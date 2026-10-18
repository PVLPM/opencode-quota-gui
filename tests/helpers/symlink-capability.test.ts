import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { symlinkOrSkip, symlinkUnsupportedErrorCode } from "./symlink-capability.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-quota-symlink-capability-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("symlink capability gating", () => {
  it("classifies only host-capability errno codes as skippable", () => {
    for (const code of ["EPERM", "EACCES", "ENOSYS", "ENOTSUP"]) {
      expect(symlinkUnsupportedErrorCode(Object.assign(new Error("x"), { code }))).toBe(code);
    }
    for (const code of ["ENOENT", "EEXIST", "EINVAL", "EUNKNOWN"]) {
      expect(symlinkUnsupportedErrorCode(Object.assign(new Error("x"), { code }))).toBeUndefined();
    }
    expect(symlinkUnsupportedErrorCode(new Error("no code"))).toBeUndefined();
    expect(symlinkUnsupportedErrorCode(undefined)).toBeUndefined();
  });

  it("rethrows a non-capability errno instead of skipping the test", () => {
    const dir = makeTempDir();
    const skip = vi.fn();

    expect(() =>
      symlinkOrSkip({ skip }, join(dir, "target.txt"), join(dir, "missing", "link.txt")),
    ).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(skip).not.toHaveBeenCalled();
  });

  it("reports a capability skip only when the host really refuses the link", () => {
    const dir = makeTempDir();
    const skip = vi.fn();
    const target = join(dir, "target.txt");
    writeFileSync(target, "x");

    const created = symlinkOrSkip({ skip }, target, join(dir, "link.txt"), "file");

    if (created) {
      expect(skip).not.toHaveBeenCalled();
    } else {
      expect(skip).toHaveBeenCalledWith(
        expect.stringMatching(/cannot create symlinks \((EPERM|EACCES|ENOSYS|ENOTSUP)\)/u),
      );
    }
  });
});
