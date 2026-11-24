import { describe, expect, it } from "vitest";
import { orderRowsByPreference } from "../src/contracts/row-order";

const rows = [
  { rowId: "card#a", label: "A" },
  { rowId: "card#b", label: "B" },
  { rowId: "card#c", label: "C" },
];

describe("row order preference", () => {
  it("keeps provider emission order when no order is saved", () => {
    for (const order of [undefined, []]) {
      expect(orderRowsByPreference(rows, order).map((row) => row.rowId)).toEqual([
        "card#a",
        "card#b",
        "card#c",
      ]);
    }
    expect(rows.map((row) => row.rowId)).toEqual(["card#a", "card#b", "card#c"]);
  });

  it("puts listed rows first in saved order and appends new rows in emission order", () => {
    expect(
      orderRowsByPreference(rows, ["card#c", "card#missing", "card#a"]).map((row) => row.rowId),
    ).toEqual(["card#c", "card#a", "card#b"]);
  });

  it("ignores duplicate saved ids, keeping the first position", () => {
    expect(
      orderRowsByPreference(rows, ["card#b", "card#b", "card#a"]).map((row) => row.rowId),
    ).toEqual(["card#b", "card#a", "card#c"]);
  });

  it("accepts a caller-supplied id reader for UI rows", () => {
    const uiRows = [
      { id: "card#a", label: "A" },
      { id: "card#b", label: "B" },
    ];
    expect(orderRowsByPreference(uiRows, ["card#b"], (row) => row.id).map((row) => row.id)).toEqual(
      ["card#b", "card#a"],
    );
  });

  it("never mutates the input array", () => {
    const input = [...rows];
    orderRowsByPreference(input, ["card#c"]);
    expect(input.map((row) => row.rowId)).toEqual(["card#a", "card#b", "card#c"]);
  });

  it("resolves a saved alias id to the stable control id", () => {
    const controls = [{ rowId: "card#b", aliases: ["card#b|value"] }];
    const mixed = [{ rowId: "card#a" }, { rowId: "card#b|value" }, { rowId: "card#c" }];
    const order = (saved: string[]) =>
      orderRowsByPreference(mixed, saved, (row) => row.rowId, controls).map((row) => row.rowId);
    expect(order(["card#b"])).toEqual(["card#b|value", "card#a", "card#c"]);
    expect(order(["card#b|value"])).toEqual(["card#b|value", "card#a", "card#c"]);
  });
});
