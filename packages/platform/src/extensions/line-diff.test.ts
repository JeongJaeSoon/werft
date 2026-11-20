import { describe, expect, test } from "bun:test";
import { unifiedLineDiff } from "./line-diff.ts";

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, n) => `${prefix} ${n + 1}`);

describe("unifiedLineDiff", () => {
  test("equal texts give no hunk", () => {
    expect(unifiedLineDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  test("a changed line shows with three lines of context each side", () => {
    const before = lines(10);
    const after = [...before];
    after[4] = "changed";
    expect(unifiedLineDiff(before.join("\n"), after.join("\n"))).toBe(
      [
        "@@ -2,7 +2,7 @@",
        " line 2",
        " line 3",
        " line 4",
        "-line 5",
        "+changed",
        " line 6",
        " line 7",
        " line 8",
      ].join("\n"),
    );
  });

  test("changes far apart are separate hunks, near ones one", () => {
    const before = lines(30);
    const far = [...before];
    far[2] = "x";
    far[25] = "y";
    expect(
      unifiedLineDiff(before.join("\n"), far.join("\n"))?.match(/^@@/gm),
    ).toHaveLength(2);
    const near = [...before];
    near[2] = "x";
    near[6] = "y";
    expect(
      unifiedLineDiff(before.join("\n"), near.join("\n"))?.match(/^@@/gm),
    ).toHaveLength(1);
  });

  test("added and removed lines count on their own side", () => {
    expect(unifiedLineDiff("a\nb", "a\nb\nc\nd")).toBe(
      "@@ -1,2 +1,4 @@\n a\n b\n+c\n+d",
    );
    expect(unifiedLineDiff("a\nb\nc", "a")).toBe("@@ -1,3 +1,1 @@\n a\n-b\n-c");
    expect(unifiedLineDiff("", "new")).toBe("@@ -1,1 +1,1 @@\n-\n+new");
  });

  test("a change too large to compare gives null; a small one in a large file does not", () => {
    expect(
      unifiedLineDiff(lines(3000, "a").join("\n"), lines(3000, "b").join("\n")),
    ).toBeNull();
    const big = lines(50_000);
    const edited = [...big];
    edited[25_000] = "changed";
    expect(unifiedLineDiff(big.join("\n"), edited.join("\n"))).toContain(
      "+changed",
    );
  });
});
