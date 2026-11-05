import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withCanonicalConfigLock } from "../src/lib/canonical-config-lock.js";

describe("canonical config write lock", () => {
  it("serializes cooperating asynchronous rename writers without losing either edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quota-canonical-lock-"));
    const path = join(directory, "config.jsonc");
    await writeFile(path, "{}", "utf8");

    let releaseFirst!: () => void;
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const pauseFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    try {
      const first = withCanonicalConfigLock(path, async () => {
        const captured = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        signalFirstEntered();
        await pauseFirst;
        const staged = join(directory, "first.tmp");
        await writeFile(staged, JSON.stringify({ ...captured, proposal: true }), "utf8");
        await rename(staged, path);
      });
      await firstEntered;

      const second = withCanonicalConfigLock(path, async () => {
        secondStarted = true;
        const captured = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        const staged = join(directory, "second.tmp");
        await writeFile(staged, JSON.stringify({ ...captured, guiSetting: true }), "utf8");
        await rename(staged, path);
      });

      await Promise.resolve();
      expect(secondStarted).toBe(false);
      releaseFirst();
      await Promise.all([first, second]);

      await expect(readFile(path, "utf8")).resolves.toBe(
        JSON.stringify({ proposal: true, guiSetting: true }),
      );
    } finally {
      releaseFirst();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
