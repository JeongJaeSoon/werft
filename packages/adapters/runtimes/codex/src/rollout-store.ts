import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digestParts } from "@werft-ai/runtime-codec-kit";
import {
  type CheckpointObjectStore,
  type CheckpointTranscripts,
  type ObjectRef,
  TRANSCRIPT_LIMITS,
  type TranscriptCapture,
  type TranscriptLimits,
  type TranscriptStore,
  type TranscriptStoreOptions,
  TranscriptTooLargeError,
  transcriptGenerationDirectory,
  transcriptSizeProblem,
} from "@werft-ai/runtime-core";

import { codexHomeIn } from "./config.ts";
import { findRollout } from "./run.ts";

/**
 * A rollout is cut into parts of this size, in file order. The file only
 * grows, so every part but the last stays the same between checkpoints and is
 * reused rather than uploaded again.
 */
export const ROLLOUT_PART_BYTES = 4 * 1024 * 1024;

const ROLLOUT_DIRECTORY = "rollout";
const RELATIVE_PATH = /^\d{4}\/\d{2}\/\d{2}\/rollout-[0-9A-Za-z-]+\.jsonl$/;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The transcript of a Codex thread is its rollout file, kept as the bytes the
 * engine wrote (never parsed, so what a restore writes is what was captured).
 * A checkpoint reads the file when the run is quiet, uploads it as write-once
 * parts named by their digest, and pins the part list; a restore writes the
 * parts back to the same path under the engine's home, where
 * `thread/resume` finds the thread by its id.
 *
 * There is no mirror: the engine writes to its own disk and is read at the
 * checkpoint. A worker that dies between two checkpoints loses that part of
 * the thread, as it loses the workspace; the last checkpoint stands.
 */
export class CodexRolloutStore implements TranscriptStore, TranscriptCapture {
  readonly #objects: CheckpointObjectStore;
  readonly #namespace: string;
  readonly #prefix: string;
  readonly #home: string | undefined;
  readonly #limits: TranscriptLimits;
  readonly #inherit:
    | { sessionId: string; parts: readonly ObjectRef[]; relativePath: string }
    | undefined;
  /** Parts already in the store, by digest and length, adopted or written here. */
  readonly #known = new Map<string, ObjectRef>();
  #persistedAt: Date | null = null;

  constructor(options: TranscriptStoreOptions) {
    const { generation } = options;
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error(`Invalid execution generation: ${generation}`);
    }
    const trimmed = options.prefix.replace(/^\/+|\/+$/g, "");
    this.#objects = options.objects;
    this.#namespace = trimmed === "" ? "" : `${trimmed}/`;
    this.#prefix = `${this.#namespace}${transcriptGenerationDirectory(generation)}`;
    this.#home =
      options.engineDirectory === undefined
        ? undefined
        : codexHomeIn(options.engineDirectory);
    this.#limits = options.transcriptLimits ?? TRANSCRIPT_LIMITS;
    if (options.inherit !== undefined) {
      const { sessionId, transcripts } = options.inherit;
      const parts = transcripts.root.parts;
      this.#inherit = {
        sessionId,
        parts,
        relativePath: this.#relativePathOf(parts, sessionId),
      };
      for (const part of parts) this.#known.set(this.#identity(part), part);
    }
  }

  get persistedAt(): Date | null {
    return this.#persistedAt;
  }

  /** Nothing is mirrored while the engine runs, so nothing can be behind. */
  get unsettled(): boolean {
    return false;
  }

  /**
   * Parts are write-once under keys that name their digest, so two launches
   * of one generation cannot disagree about a key: there is nothing to claim.
   */
  ready(): Promise<void> {
    return Promise.resolve();
  }

  async verifyInherited(signal?: AbortSignal): Promise<void> {
    for (const part of this.#inherit?.parts ?? []) {
      signal?.throwIfAborted();
      await this.#adoptedBody(part);
    }
  }

  async materialize(projects: string, signal?: AbortSignal): Promise<void> {
    const inherit = this.#inherit;
    if (inherit === undefined) {
      throw new Error("Only a store that adopted a checkpoint materializes it");
    }
    const target = join(
      codexHomeIn(projects),
      "sessions",
      inherit.relativePath,
    );
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Whole or not at all: the engine finds the thread or does not.
    const staging = `${target}.restoring`;
    const file = await open(staging, "w", 0o600);
    try {
      for (const part of inherit.parts) {
        signal?.throwIfAborted();
        await file.write(await this.#adoptedBody(part));
      }
      await file.sync();
    } catch (error) {
      await file.close();
      await rm(staging, { force: true });
      throw error;
    }
    await file.close();
    await rename(staging, target);
  }

  async transcriptSizes(
    sessionId: string,
  ): Promise<Array<{ bytes: number; key: string }> | null> {
    const path = await this.#rolloutOf(sessionId);
    if (path === undefined) return null;
    const { size } = await stat(path);
    if (size === 0) return null;
    const sizes: Array<{ bytes: number; key: string }> = [];
    for (let at = 0, index = 0; at < size; at += ROLLOUT_PART_BYTES, index++) {
      sizes.push({
        bytes: Math.min(ROLLOUT_PART_BYTES, size - at),
        key: `${this.#prefix}/${ROLLOUT_DIRECTORY}/${index}`,
      });
    }
    return sizes;
  }

  async captureTranscripts(
    sessionId: string,
  ): Promise<CheckpointTranscripts | null> {
    const path = await this.#rolloutOf(sessionId);
    const sizes = await this.transcriptSizes(sessionId);
    if (path === undefined || sizes === null) return null;
    const problem = transcriptSizeProblem(sizes, this.#limits);
    if (problem !== undefined) throw new TranscriptTooLargeError(problem);

    const relativePath = this.#relativePathUnder(path, sessionId);
    const parts: ObjectRef[] = [];
    let entryCount = 0;
    const file = await open(path, "r");
    try {
      for (const { bytes } of sizes) {
        const body = new Uint8Array(bytes);
        const { bytesRead } = await file.read(body, 0, bytes, null);
        // The file only grows; a shorter read is a file replaced under us.
        if (bytesRead !== bytes) {
          throw new Error(
            `The rollout of ${sessionId} changed while it was read`,
          );
        }
        entryCount += body.reduce((n, byte) => n + (byte === 0x0a ? 1 : 0), 0);
        parts.push(await this.#store(body, relativePath));
      }
    } finally {
      await file.close();
    }
    this.#persistedAt = new Date();
    return {
      root: { entryCount, parts, sha256: digestParts(parts) },
      subagents: {},
    };
  }

  // --- internals -------------------------------------------------------

  async #rolloutOf(sessionId: string): Promise<string | undefined> {
    if (this.#home === undefined) {
      throw new Error("The store was opened without the engine's directory");
    }
    return findRollout(this.#home, sessionId);
  }

  #relativePathUnder(path: string, sessionId: string): string {
    const marker = `${this.#home}/sessions/`;
    const relative = path.slice(marker.length);
    if (
      !relative.endsWith(`-${sessionId}.jsonl`) ||
      !RELATIVE_PATH.test(relative)
    ) {
      throw new Error(
        `The rollout of ${sessionId} is not where the engine writes it`,
      );
    }
    return relative;
  }

  #identity(part: { bytes: number; sha256: string }): string {
    return `${part.bytes}:${part.sha256}`;
  }

  async #store(body: Uint8Array, relativePath: string): Promise<ObjectRef> {
    const digest = sha256(body);
    const known = this.#known.get(`${body.byteLength}:${digest}`);
    if (known !== undefined) return known;
    const key = `${this.#prefix}/${ROLLOUT_DIRECTORY}/${relativePath}/${digest}`;
    const result = await this.#objects.putImmutable(key, body, {
      contentAddressed: true,
    });
    if (result.outcome === "conflict") {
      throw new Error(`${key} holds other bytes than its digest names`);
    }
    const ref: ObjectRef = {
      bytes: body.byteLength,
      key,
      sha256: digest,
      ...(result.version === undefined ? {} : { version: result.version }),
    };
    this.#known.set(this.#identity(ref), ref);
    return ref;
  }

  /** `<generation>/rollout/<yyyy>/<mm>/<dd>/<file>/<digest>` → the path under `sessions/`. */
  #relativePathOf(parts: readonly ObjectRef[], sessionId: string): string {
    const paths = new Set(
      parts.map((part) => {
        const rest = part.key.startsWith(this.#namespace)
          ? part.key.slice(this.#namespace.length).split("/")
          : [];
        // generation-N / rollout / ...path / digest
        return rest.length < 4 || rest[1] !== ROLLOUT_DIRECTORY
          ? ""
          : rest.slice(2, -1).join("/");
      }),
    );
    const [relative] = paths;
    if (
      paths.size !== 1 ||
      relative === undefined ||
      !RELATIVE_PATH.test(relative) ||
      !relative.endsWith(`-${sessionId}.jsonl`)
    ) {
      throw new Error(
        `The transcript of ${sessionId} is not one rollout file: ${[...paths].join(", ")}`,
      );
    }
    return relative;
  }

  async #adoptedBody(part: ObjectRef): Promise<Uint8Array> {
    const body = await this.#objects.get(part.key, part.version);
    if (body === undefined)
      throw new Error(`Transcript part ${part.key} is gone`);
    if (body.byteLength !== part.bytes || sha256(body) !== part.sha256) {
      throw new Error(
        `Transcript part ${part.key} does not match what was pinned`,
      );
    }
    return body;
  }
}
