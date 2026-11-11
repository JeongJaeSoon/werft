import { createHash } from "node:crypto";

export type BundleInputKind =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "device";

export type BundleInputFile = {
  /** Slash-separated path relative to the bundle root, as found in the archive. */
  path: string;
  kind: BundleInputKind;
  /** POSIX permission bits; only the execute bit is read. */
  mode: number;
  bytes: Uint8Array;
};

export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** sha256 of one `<mode> <path> <file sha256>` line per file, in path order. */
export function bundleDigest(
  files: readonly { path: string; mode: number; sha256: string }[],
): string {
  const lines = [...files]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((file) => `${file.mode.toString(8)} ${file.path} ${file.sha256}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}

/**
 * The tar a stored bundle travels in. Tar is only a transport: the
 * digest is taken over the canonical file list, so a different tar library,
 * compression or mtime never changes a bundle's version. The writer is
 * byte-for-byte deterministic anyway, so a stored object is reproducible.
 *
 * Only plain ustar is read. A reader that accepted pax or GNU long names would
 * disagree with the writer about what a path is, and the stored tar is always
 * re-validated after it is read.
 */

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class BundleArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleArchiveError";
  }
}

export type ArchiveFile = {
  path: string;
  mode: number;
  bytes: Uint8Array;
};

const byPath = (a: ArchiveFile, b: ArchiveFile) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function octal(value: number, width: number): Uint8Array {
  return encoder.encode(`${value.toString(8).padStart(width - 1, "0")}\0`);
}

function splitName(path: string): { name: string; prefix: string } {
  const bytes = encoder.encode(path);
  if (bytes.length <= NAME_MAX) return { name: path, prefix: "" };
  for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (
      encoder.encode(prefix).length <= PREFIX_MAX &&
      encoder.encode(name).length <= NAME_MAX
    ) {
      return { name, prefix };
    }
  }
  throw new BundleArchiveError(`Path is too long for a tar header: ${path}`);
}

function header(file: ArchiveFile): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const { name, prefix } = splitName(file.path);
  block.set(encoder.encode(name), 0);
  block.set(octal(file.mode & 0o777, 8), 100);
  block.set(octal(0, 8), 108); // uid
  block.set(octal(0, 8), 116); // gid
  block.set(octal(file.bytes.byteLength, 12), 124);
  block.set(octal(0, 12), 136); // mtime
  block.fill(0x20, 148, 156); // checksum counts itself as spaces
  block[156] = 0x30; // regular file
  block.set(encoder.encode("ustar\0"), 257);
  block.set(encoder.encode("00"), 263);
  block.set(encoder.encode(prefix), 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return block;
}

export function packBundleTar(files: readonly ArchiveFile[]): Uint8Array {
  const sorted = [...files].sort(byPath);
  let size = 2 * BLOCK;
  for (const file of sorted) {
    size += BLOCK + Math.ceil(file.bytes.byteLength / BLOCK) * BLOCK;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const file of sorted) {
    out.set(header(file), at);
    out.set(file.bytes, at + BLOCK);
    at += BLOCK + Math.ceil(file.bytes.byteLength / BLOCK) * BLOCK;
  }
  return out;
}

function cString(block: Uint8Array, from: number, length: number): string {
  const field = block.subarray(from, from + length);
  const end = field.indexOf(0);
  try {
    return decoder.decode(end === -1 ? field : field.subarray(0, end));
  } catch {
    throw new BundleArchiveError("A tar header field is not valid UTF-8.");
  }
}

function octalField(block: Uint8Array, from: number, length: number): number {
  if (((block[from] ?? 0) & 0x80) !== 0) {
    throw new BundleArchiveError("Base-256 tar numbers are not supported.");
  }
  const text = cString(block, from, length).trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new BundleArchiveError("A tar header number is not octal.");
  }
  return Number.parseInt(text, 8);
}

const KINDS: Record<string, BundleInputKind> = {
  "0": "file",
  "\0": "file",
  "1": "hardlink",
  "2": "symlink",
  "3": "device",
  "4": "device",
  "5": "directory",
  "6": "device",
};

/**
 * Entries as found, for the validator to judge: a symlink or directory comes
 * back with its kind rather than being dropped here. What this refuses is a
 * tar it cannot read faithfully (bad checksum, truncation, extension headers).
 */
export function unpackBundleTar(tar: Uint8Array): BundleInputFile[] {
  if (tar.byteLength % BLOCK !== 0) {
    throw new BundleArchiveError("Tar length is not a multiple of 512.");
  }
  const entries: BundleInputFile[] = [];
  let at = 0;
  let ended = false;
  while (at < tar.byteLength) {
    const block = tar.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
    }
    if (octalField(block, 148, 8) !== sum) {
      throw new BundleArchiveError("Tar header checksum mismatch.");
    }
    const type = String.fromCharCode(block[156] ?? 0);
    const kind = KINDS[type];
    if (kind === undefined) {
      throw new BundleArchiveError(`Unsupported tar entry type ${type}.`);
    }
    if (cString(block, 257, 6) !== "ustar") {
      throw new BundleArchiveError("Not a ustar entry.");
    }
    const name = cString(block, 0, 100);
    const prefix = cString(block, 345, 155);
    const size = octalField(block, 124, 12);
    const start = at + BLOCK;
    const end = start + size;
    if (end > tar.byteLength) {
      throw new BundleArchiveError("Tar entry runs past the end of the file.");
    }
    entries.push({
      path: prefix === "" ? name : `${prefix}/${name}`,
      kind,
      mode: octalField(block, 100, 8) & 0o777,
      // Copied: the caller's buffer may be reused by a streaming reader.
      bytes: tar.slice(start, end),
    });
    at = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!ended) throw new BundleArchiveError("Tar has no end-of-archive marker.");
  if (tar.subarray(at).some((byte) => byte !== 0)) {
    throw new BundleArchiveError("Tar has data after the end marker.");
  }
  return entries;
}
