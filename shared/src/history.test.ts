import { describe, expect, it } from "vitest";
import { diffLines, withContext } from "./history";

describe("diffLines", () => {
  it("marks added and removed lines", () => {
    const d = diffLines("a\nb\nc", "a\nx\nc\nd");
    expect(d).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });

  it("returns only same lines for equal texts", () => {
    expect(diffLines("a\nb", "a\nb")?.every((l) => l.kind === "same")).toBe(true);
  });

  it("collapses unchanged runs", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "changed");
    const ctx = withContext(diffLines(before, after) ?? [], 2);
    expect(ctx[0]).toBeNull();
    expect(ctx.filter((l) => l && l.kind !== "same").length).toBe(2);
    expect(ctx[ctx.length - 1]).toBeNull();
  });
});
