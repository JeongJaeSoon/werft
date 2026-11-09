import { describe, expect, test } from "bun:test";
import {
  BundleArchiveError,
  packBundleTar,
  unpackBundleTar,
} from "./bundle-archive.ts";
import {
  type BundleInputFile,
  validateExtensionBundle,
} from "./bundle-validator.ts";

const text = (value: string) => new TextEncoder().encode(value);
const skillMd = `---\nname: research\ndescription: Use for research\n---\nDo the thing.\n`;
const input = (over: Partial<BundleInputFile>[] = []): BundleInputFile[] => [
  {
    path: "skills/research/SKILL.md",
    kind: "file",
    mode: 0o644,
    bytes: text(skillMd),
  },
  {
    path: "skills/research/notes.md",
    kind: "file",
    mode: 0o644,
    bytes: text("# notes\n"),
  },
  ...over.map((entry) => ({
    path: "skills/research/extra.md",
    kind: "file" as const,
    mode: 0o644,
    bytes: text("x"),
    ...entry,
  })),
];

function digestOf(files: BundleInputFile[]): string {
  const result = validateExtensionBundle({ slug: "acme", files });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.bundle.digest;
}

/** Rewrites the fields a different tar writer would fill differently. */
function restamp(tar: Uint8Array, mtime: number, uid: number): Uint8Array {
  const out = tar.slice();
  const encoder = new TextEncoder();
  let at = 0;
  while (at < out.length && out[at] !== 0) {
    const size = Number.parseInt(
      new TextDecoder().decode(out.subarray(at + 124, at + 135)),
      8,
    );
    out.set(
      encoder.encode(`${mtime.toString(8).padStart(11, "0")}\0`),
      at + 136,
    );
    out.set(encoder.encode(`${uid.toString(8).padStart(7, "0")}\0`), at + 108);
    out.fill(0x20, at + 148, at + 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += out[at + i] ?? 0;
    out.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), at + 148);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("digest", () => {
  test("input order, mtime and owner do not change it", () => {
    const files = input();
    const first = digestOf(files);
    const reversed = digestOf([...files].reverse());
    const viaTar = digestOf(
      unpackBundleTar(restamp(packBundleTar(files), 1_700_000_000, 1000)),
    );
    expect(reversed).toBe(first);
    expect(viaTar).toBe(first);
  });

  test("an execute bit or one path change moves it", () => {
    const base = digestOf(input());
    const executable = input().map((file) =>
      file.path.endsWith("notes.md") ? { ...file, mode: 0o755 } : file,
    );
    const renamed = input().map((file) =>
      file.path.endsWith("notes.md")
        ? { ...file, path: "skills/research/other.md" }
        : file,
    );
    expect(digestOf(executable)).not.toBe(base);
    expect(digestOf(renamed)).not.toBe(base);
  });

  test("group and other write bits do not move it", () => {
    const loose = input().map((file) => ({ ...file, mode: 0o664 }));
    expect(digestOf(loose)).toBe(digestOf(input()));
  });
});

describe("tar", () => {
  test("packing is byte-for-byte deterministic whatever the order", () => {
    const files = input();
    expect(packBundleTar(files)).toEqual(packBundleTar([...files].reverse()));
  });

  test("a long path survives through the prefix field", () => {
    const path = `skills/research/${"d".repeat(60)}/${"e".repeat(60)}/note.md`;
    const [entry] = unpackBundleTar(
      packBundleTar([{ path, mode: 0o644, bytes: text("hi") }]),
    );
    expect(entry?.path).toBe(path);
    expect(entry?.bytes).toEqual(text("hi"));
  });

  test("a path that fits neither field is refused", () => {
    expect(() =>
      packBundleTar([
        { path: `skills/${"a".repeat(300)}`, mode: 0o644, bytes: text("") },
      ]),
    ).toThrow(BundleArchiveError);
  });

  test("a damaged header, a cut tar and a trailer are refused", () => {
    const tar = packBundleTar([
      { path: "skills/a/SKILL.md", mode: 0o644, bytes: text("abc") },
    ]);
    const flipped = tar.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => unpackBundleTar(flipped)).toThrow("checksum");
    expect(() => unpackBundleTar(tar.subarray(0, 1024))).toThrow(
      BundleArchiveError,
    );
    expect(() => unpackBundleTar(tar.subarray(0, 600))).toThrow(
      BundleArchiveError,
    );
    const trailer = tar.slice();
    trailer[trailer.length - 1] = 1;
    expect(() => unpackBundleTar(trailer)).toThrow("after the end");
  });

  test("a symlink entry comes back as a symlink for the validator to refuse", () => {
    const tar = packBundleTar([
      { path: "skills/a/SKILL.md", mode: 0o644, bytes: text("abc") },
    ]);
    const linked = tar.slice();
    linked[156] = 0x32; // symlink
    let sum = 0;
    linked.fill(0x20, 148, 156);
    for (let i = 0; i < 512; i++) sum += linked[i] ?? 0;
    linked.set(
      new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `),
      148,
    );
    expect(unpackBundleTar(linked)[0]?.kind).toBe("symlink");
    const result = validateExtensionBundle({
      slug: "acme",
      files: unpackBundleTar(linked),
    });
    expect(result.ok).toBe(false);
  });
});
