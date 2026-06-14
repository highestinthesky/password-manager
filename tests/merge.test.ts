import { describe, it, expect } from "vitest";
import { mergeEntries, entriesEqual, type Entry } from "../src/vault";

const e = (over: Partial<Entry> & { id: string; updatedAt: number }): Entry => ({
  title: "t", username: "u", password: "p", keywords: [],
  ...over,
});

describe("mergeEntries", () => {
  it("unions disjoint entries", () => {
    const merged = mergeEntries([e({ id: "a", updatedAt: 1 })], [e({ id: "b", updatedAt: 1 })]);
    expect(merged.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("newest write wins for the same id", () => {
    const merged = mergeEntries(
      [e({ id: "a", updatedAt: 10, password: "old" })],
      [e({ id: "a", updatedAt: 20, password: "new" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.password).toBe("new");
  });

  it("a delete (tombstone) overrides an older edit", () => {
    const local = [e({ id: "a", updatedAt: 5, password: "edited" })];
    const remote = [e({ id: "a", updatedAt: 9, deleted: true, password: "" })];
    const merged = mergeEntries(local, remote);
    expect(merged[0]!.deleted).toBe(true);
  });

  it("an older tombstone does NOT resurrect over a newer edit", () => {
    const local = [e({ id: "a", updatedAt: 3, deleted: true, password: "" })];
    const remote = [e({ id: "a", updatedAt: 8, password: "revived" })];
    const merged = mergeEntries(local, remote);
    expect(merged[0]!.deleted).toBeUndefined();
    expect(merged[0]!.password).toBe("revived");
  });

  it("is order-independent and idempotent", () => {
    const a = [e({ id: "a", updatedAt: 2 }), e({ id: "b", updatedAt: 5 })];
    const b = [e({ id: "b", updatedAt: 9 }), e({ id: "c", updatedAt: 1 })];
    const ab = mergeEntries(a, b);
    const ba = mergeEntries(b, a);
    expect(entriesEqual(ab, ba)).toBe(true);
    expect(entriesEqual(mergeEntries(ab, ab), ab)).toBe(true);
  });
});

describe("entriesEqual", () => {
  it("ignores order", () => {
    const a = [e({ id: "a", updatedAt: 1 }), e({ id: "b", updatedAt: 2 })];
    const b = [e({ id: "b", updatedAt: 2 }), e({ id: "a", updatedAt: 1 })];
    expect(entriesEqual(a, b)).toBe(true);
  });
  it("detects a field change", () => {
    expect(
      entriesEqual([e({ id: "a", updatedAt: 1, password: "x" })], [e({ id: "a", updatedAt: 1, password: "y" })]),
    ).toBe(false);
  });
});
