import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  BundleArchiveError,
  bundleDigest,
  unpackBundleTar,
  type WorkerGatewayClient,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";
import { messageOf } from "./message-of.ts";

// Provisional: the real limit is open (94S-878 "정하지 않는 것", design note U5)
// until the start-latency measurement says what a bundle may cost.
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

const RETRY_INITIAL_MS = 500;
const RETRY_MAX_MS = 8_000;

/** A bundle that cannot be published; retrying the same bytes would not help. */
export class ExtensionBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionBundleError";
  }
}

export type ExtensionBundleRef = { name: string; digest: string };

export type PublishExtensionBundlesOptions = {
  /** The image's HOME (a tmpfs): bundles land under `<home>/.ext/<digest>/`. */
  home: string;
  attemptId: string;
  bundles: readonly ExtensionBundleRef[];
  gateway: Pick<WorkerGatewayClient, "extensionBundle">;
  /** The startup budget: aborting it ends the retries. */
  signal: AbortSignal;
  maxBytes?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Makes every bundle of the claim available read-only at
 * `<home>/.ext/<digest>/`. Each is staged in `.tmp-*`, its content hash is
 * recomputed from the bytes received, and only a match is renamed into place,
 * so a published directory is always the bundle the claim named.
 */
export async function publishExtensionBundles(
  options: PublishExtensionBundlesOptions,
): Promise<string[]> {
  const root = join(options.home, ".ext");
  const published: string[] = [];
  for (const bundle of options.bundles) {
    const target = join(root, bundle.digest);
    // Only a verified rename creates this path, so a restart can reuse it.
    if (!existsSync(target)) {
      const tar = await download(options, bundle);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      place(root, target, bundle, tar);
    }
    published.push(target);
  }
  return published;
}

async function download(
  options: PublishExtensionBundlesOptions,
  bundle: ExtensionBundleRef,
): Promise<Uint8Array> {
  const fetchTar = options.gateway.extensionBundle?.bind(options.gateway);
  const label = `extension ${bundle.name} (${bundle.digest.slice(0, 12)})`;
  if (fetchTar === undefined) {
    throw new ExtensionBundleError(
      `${label}: the gateway client cannot fetch bundles`,
    );
  }
  const sleep = options.sleep ?? pause;
  let delay = RETRY_INITIAL_MS;
  for (;;) {
    try {
      return await fetchTar(options.attemptId, bundle.digest, {
        maxBytes: options.maxBytes ?? MAX_BUNDLE_BYTES,
        signal: options.signal,
      });
    } catch (error) {
      if (!(error instanceof WorkerGatewayRequestError)) throw error;
      if (!error.retryable) {
        throw new ExtensionBundleError(`${label}: ${error.message}`);
      }
      if (!options.signal.aborted) await sleep(delay, options.signal);
      if (options.signal.aborted) {
        throw new ExtensionBundleError(
          `${label}: the startup budget ran out while retrying (${error.message})`,
        );
      }
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    }
  }
}

function safePath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function place(
  root: string,
  target: string,
  bundle: ExtensionBundleRef,
  tar: Uint8Array,
): void {
  const label = `extension ${bundle.name} (${bundle.digest.slice(0, 12)})`;
  let staged: string | undefined;
  try {
    let entries: ReturnType<typeof unpackBundleTar>;
    try {
      entries = unpackBundleTar(tar);
    } catch (error) {
      if (error instanceof BundleArchiveError) {
        throw new ExtensionBundleError(`${label}: ${error.message}`);
      }
      throw error;
    }
    const seen = new Set<string>();
    const files = entries.map((entry) => {
      if (entry.kind !== "file") {
        throw new ExtensionBundleError(
          `${label}: ${entry.path} is a ${entry.kind}, only regular files are published`,
        );
      }
      if (!safePath(entry.path) || seen.has(entry.path)) {
        throw new ExtensionBundleError(
          `${label}: path ${JSON.stringify(entry.path)} is unsafe or repeated`,
        );
      }
      seen.add(entry.path);
      const mode = (entry.mode & 0o111) !== 0 ? 0o755 : 0o644;
      return {
        path: entry.path,
        mode,
        bytes: entry.bytes,
        sha256: createHash("sha256").update(entry.bytes).digest("hex"),
      };
    });
    const actual = bundleDigest(files);
    if (actual !== bundle.digest) {
      throw new ExtensionBundleError(
        `${label}: the bytes received hash to ${actual.slice(0, 12)}, not the claimed digest`,
      );
    }
    staged = mkdtempSync(join(root, `.tmp-${randomBytes(4).toString("hex")}-`));
    const dirs = new Set<string>([staged]);
    for (const file of files) {
      const at = join(staged, file.path);
      for (
        let dir = dirname(at);
        dir !== staged && !dirs.has(dir);
        dir = dirname(dir)
      ) {
        dirs.add(dir);
      }
      mkdirSync(dirname(at), { recursive: true, mode: 0o700 });
      writeFileSync(at, file.bytes, { flag: "wx", mode: 0o600 });
      chmodSync(at, file.mode === 0o755 ? 0o555 : 0o444);
    }
    // Deepest first, so a directory is closed after its children.
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
      chmodSync(dir, 0o555);
    }
    renameSync(staged, target);
    staged = undefined;
  } catch (error) {
    if (staged !== undefined) discard(staged);
    if (error instanceof ExtensionBundleError) throw error;
    throw new ExtensionBundleError(`${label}: ${messageOf(error)}`);
  }
}

function discard(path: string): void {
  const open = (dir: string) => {
    try {
      chmodSync(dir, 0o700);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) open(join(dir, entry.name));
      }
    } catch {
      // Already gone or never closed: the removal below is what matters.
    }
  };
  open(path);
  rmSync(path, { recursive: true, force: true });
}
