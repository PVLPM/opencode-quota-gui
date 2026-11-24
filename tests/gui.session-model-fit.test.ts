import { describe, expect, it } from "vitest";
import { fitModelIdentities } from "../src/ui/session-model-fit";

describe("session header model fit", () => {
  const entryWidths = [80, 90, 70, 100];
  const separatorWidth = 12;
  const overflowWidth = 26;

  const fit = (availableWidth: number) =>
    fitModelIdentities({ availableWidth, entryWidths, separatorWidth, overflowWidth });

  it("shows every identity when the whole ordered list fits", () => {
    expect(fit(1000)).toEqual({ visibleCount: 4, overflowCount: 0 });
    // 80 + 12 + 90 + 12 + 70 + 12 + 100 = 376.
    expect(fit(376)).toEqual({ visibleCount: 4, overflowCount: 0 });
  });

  it("reserves the separator and one overflow bubble before fitting entries", () => {
    // Two entries end at 182; the bubble adds a separator and 26px: 220.
    expect(fit(220)).toEqual({ visibleCount: 2, overflowCount: 2 });
    // Three entries end at 264; with the bubble: 302.
    expect(fit(302)).toEqual({ visibleCount: 3, overflowCount: 1 });
    expect(fit(375.9)).toEqual({ visibleCount: 3, overflowCount: 1 });
  });

  it("reports only the bubble when no complete entry fits", () => {
    expect(fit(10)).toEqual({ visibleCount: 0, overflowCount: 4 });
    expect(fit(Number.NaN)).toEqual({ visibleCount: 0, overflowCount: 4 });
  });

  it("handles an empty identity list", () => {
    expect(
      fitModelIdentities({
        availableWidth: 400,
        entryWidths: [],
        separatorWidth,
        overflowWidth,
      }),
    ).toEqual({ visibleCount: 0, overflowCount: 0 });
  });
});
