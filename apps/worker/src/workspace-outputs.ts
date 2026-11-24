import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, stat } from "node:fs/promises";
import {
  type CheckpointOutput,
  type StoredOutput,
  workspacePathProblem,
} from "@werft-ai/runtime-core";

/** Where the engine is told to leave files meant for a person. */
export const OUTPUT_DIRECTORY = "out";

export type OutputLimits = {
  /** A file over this is listed as `too_large` and not uploaded. */
  maxFileBytes: number;
  /**
   * What one checkpoint uploads in all; a file that would take the sum past
   * it is listed as `too_large`. Files are read one at a time, so this bounds
   * upload time and storage, not memory.
   */
  maxTotalBytes: number;
  /** Files listed, in walk order; the rest are left out of the manifest. */
  maxFiles: number;
};

/** Documented in apps/docs/content/docs/run-server/self-hosting/capacity.mdx. */
export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFiles: 1_000,
};

// A directory chain deeper than this is not walked: each level holds a
// descriptor until its walk ends.
const MAX_DEPTH = 32;

const DIRECTORY =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// Non-blocking so a FIFO opens at once and is skipped by the fstat.
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type OutputIndex = {
  outputs: CheckpointOutput[];
  /** Regular files past `maxFiles`, left out. */
  dropped: number;
  /** Why the walk listed nothing, when `out/` exists but cannot be read safely. */
  refused?: string;
};

/**
 * Indexes the regular files under `<workspaceRoot>/out/`, whatever git makes
 * of them. Never fails a checkpoint over what the engine put there: a
 * symlink, a FIFO, a name no manifest could carry or a file that changes
 * while it is read is skipped, and a file over the limits is listed without
 * its bytes. Faults that are not about the files (EIO) throw.
 *
 * The walk runs in the worker process, so it never follows a link: every
 * directory and file is opened `O_NOFOLLOW` through the descriptor of the
 * directory it sits in, the way untracked files are read
 * (`readWorkspaceFile`). A `out/x -> /proc/self/environ` would otherwise
 * upload the worker's own credentials to a place a person downloads from.
 *
 * `store` receives one file at a time and returns its ref, so at most one
 * file is held in memory.
 */
export async function indexOutputs(input: {
  limits?: OutputLimits;
  store: (file: { bytes: Uint8Array; path: string }) => Promise<StoredOutput>;
  workspaceRoot: string;
  fdDirectory?: string;
}): Promise<OutputIndex> {
  const limits = input.limits ?? DEFAULT_OUTPUT_LIMITS;
  const fdDirectory = input.fdDirectory ?? "/proc/self/fd";
  const outputs: CheckpointOutput[] = [];
  let dropped = 0;
  let left = limits.maxTotalBytes;

  const root = await openDirectory(input.workspaceRoot);
  if (root === undefined) return { outputs, dropped };
  try {
    if (!(await addressable(root, fdDirectory))) {
      return {
        outputs,
        dropped,
        refused: `${fdDirectory} does not address directories by descriptor here`,
      };
    }
    const top = await openDirectory(
      `${fdDirectory}/${root.fd}/${OUTPUT_DIRECTORY}`,
    );
    if (top === undefined) return { outputs, dropped };

    const visitFile = async (
      parent: FileHandle,
      name: string,
      path: string,
    ) => {
      let file: FileHandle;
      try {
        file = await open(`${fdDirectory}/${parent.fd}/${name}`, FILE);
      } catch (error) {
        if (CONFINEMENT_ERRORS.has(errorCode(error) ?? "")) return;
        throw error;
      }
      try {
        const info = await file.stat();
        if (!info.isFile()) return;
        if (outputs.length >= limits.maxFiles) {
          dropped += 1;
          return;
        }
        if (info.size > limits.maxFileBytes || info.size > left) {
          outputs.push({ bytes: info.size, omitted: "too_large", path });
          return;
        }
        // One byte past what fstat said, so a file still growing is noticed.
        const buffer = new Uint8Array(info.size + 1);
        let filled = 0;
        while (filled < buffer.byteLength) {
          const { bytesRead } = await file.read(
            buffer,
            filled,
            buffer.byteLength - filled,
          );
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        if (filled !== info.size) return;
        left -= filled;
        outputs.push(
          await input.store({ bytes: buffer.subarray(0, filled), path }),
        );
      } finally {
        await file.close().catch(() => undefined);
      }
    };

    const walk = async (
      directory: FileHandle,
      prefix: string,
      depth: number,
    ) => {
      // Read as bytes: a lossy decode turns `\xff` into U+FFFD, the name of
      // another file, and the manifest would then list one path twice. Bun
      // gives no file types with byte names, so each entry is lstat'ed.
      const names = (
        await readdir(`${fdDirectory}/${directory.fd}`, { encoding: "buffer" })
      )
        .flatMap((bytes) => {
          const name = utf8(bytes);
          return name === undefined ? [] : [name];
        })
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const name of names) {
        const path = `${prefix}/${name}`;
        // A name the manifest would refuse (`.git`, a backslash) is skipped
        // here, or the whole checkpoint goes.
        if (workspacePathProblem(path) !== undefined) continue;
        let entry: Stats;
        try {
          entry = await lstat(`${fdDirectory}/${directory.fd}/${name}`);
        } catch (error) {
          if (CONFINEMENT_ERRORS.has(errorCode(error) ?? "")) continue;
          throw error;
        }
        if (entry.isDirectory()) {
          if (depth >= MAX_DEPTH) continue;
          const child = await openDirectory(
            `${fdDirectory}/${directory.fd}/${name}`,
          );
          if (child === undefined) continue;
          try {
            await walk(child, path, depth + 1);
          } finally {
            await child.close().catch(() => undefined);
          }
        } else if (entry.isFile()) {
          await visitFile(directory, name, path);
        }
      }
    };
    try {
      await walk(top, OUTPUT_DIRECTORY, 1);
    } finally {
      await top.close().catch(() => undefined);
    }
  } finally {
    await root.close().catch(() => undefined);
  }
  return { outputs, dropped };
}

const CONFINEMENT_ERRORS = new Set([
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ENAMETOOLONG",
  "EACCES",
  "ENXIO",
]);

/** Undefined for anything that is not a directory reached without a link. */
async function openDirectory(at: string): Promise<FileHandle | undefined> {
  try {
    return await open(at, DIRECTORY);
  } catch (error) {
    if (CONFINEMENT_ERRORS.has(errorCode(error) ?? "")) return undefined;
    throw error;
  }
}

async function addressable(
  handle: FileHandle,
  fdDirectory: string,
): Promise<boolean> {
  const [direct, viaDirectory] = await Promise.all([
    handle.stat(),
    stat(`${fdDirectory}/${handle.fd}`).catch(() => undefined),
  ]);
  return (
    viaDirectory !== undefined &&
    viaDirectory.dev === direct.dev &&
    viaDirectory.ino === direct.ino
  );
}

function utf8(name: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      name,
    );
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
