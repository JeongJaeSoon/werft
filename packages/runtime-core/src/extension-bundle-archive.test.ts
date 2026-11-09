import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  BundleArchiveError,
  bundleDigest,
  packBundleTar,
  unpackBundleTar,
} from "./extension-bundle-archive.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("bundleDigest", () => {
  test("hashes one `<mode> <path> <sha>` line per file in path order, whatever the input order", () => {
    const a = { path: "a/x", mode: 0o644, sha256: sha("x") };
    const b = { path: "b", mode: 0o755, sha256: sha("y") };
    const expected = createHash("sha256")
      .update(`644 a/x ${sha("x")}\n755 b ${sha("y")}\n`)
      .digest("hex");
    expect(bundleDigest([a, b])).toBe(expected);
    expect(bundleDigest([b, a])).toBe(expected);
  });
});

describe("the tar reader", () => {
  const files = [
    {
      path: "skills/a/SKILL.md",
      mode: 0o644,
      bytes: new TextEncoder().encode("hi"),
    },
  ];

  test("reads back what the writer wrote, as regular files", () => {
    const back = unpackBundleTar(packBundleTar(files));
    expect(back.map((f) => [f.path, f.kind, f.mode])).toEqual([
      ["skills/a/SKILL.md", "file", 0o644],
    ]);
    expect(new TextDecoder().decode(back[0]?.bytes)).toBe("hi");
  });

  test("refuses a tar it cannot read faithfully", () => {
    const tar = packBundleTar(files);
    tar[10] = (tar[10] ?? 0) ^ 0xff;
    expect(() => unpackBundleTar(tar)).toThrow(BundleArchiveError);
    expect(() => unpackBundleTar(tar.subarray(0, 100))).toThrow(
      BundleArchiveError,
    );
  });
});
