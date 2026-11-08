/**
 * The checkpoint contract every runtime adapter and the control plane share.
 *
 * A mirror that is up to date is not a checkpoint. What makes a session safely
 * resumable is one immutable manifest that pins, at a single quiescent moment,
 * the exact transcript parts, the workspace commit, and the engine build that
 * produced them. Restore reads that manifest and nothing else: never the latest
 * mirror suffix, never the branch head.
 */

import type { AttributionMismatch } from "./commit-attribution.ts";

export type ObjectRef = {
  readonly bytes: number;
  readonly key: string;
  readonly sha256: string;
  /**
   * The store's version id for the exact write these bytes came from — what
   * `putImmutable` answered. A key says where an object lives *now*; a
   * delete marker, a lifecycle rule or a privileged overwrite can change that
   * after the pointer has moved, and verifying the key again at restore only
   * finds the damage. A version cannot change, so a checkpoint that names one
   * is verified and restored from the same bytes.
   *
   * Absent only on a store without versions (the in-memory testkit, or a
   * bucket without versioning). A control plane with `objectProtection:
   * "locked"` refuses a manifest that leaves one out; an `"unversioned"` one
   * ignores them and reads by key.
   */
  readonly version?: string;
};

/**
 * One transcript pinned to exact bytes. `parts` is the ordered part list at
 * capture time; suffixes the mirror writes afterwards are not part of it.
 * `sha256` digests the part list itself, so a manifest cannot be edited to
 * point at a different set of parts without detection.
 */
export type TranscriptRevision = {
  readonly entryCount: number;
  readonly parts: readonly ObjectRef[];
  readonly sha256: string;
};

/** Everything that must match for a stored transcript to be replayable. */
export type RuntimeFingerprint = {
  readonly cliVersion: string;
  readonly engine: string;
  /** Digest of the allowlisted config profile, secrets excluded. */
  readonly profileSha256: string;
  readonly sdkVersion: string;
};

/**
 * The fingerprint a manifest is held to: `runtime`, or `runtime` with the
 * manifest's own profile digest when that is one the session ran before its
 * profile was changed. Engine, CLI and SDK versions must still match.
 */
export function runtimeFor(
  manifest: { readonly runtime: RuntimeFingerprint },
  runtime: RuntimeFingerprint,
  alternates: readonly string[],
): RuntimeFingerprint {
  return alternates.includes(manifest.runtime.profileSha256)
    ? { ...runtime, profileSha256: manifest.runtime.profileSha256 }
    : runtime;
}

/**
 * An object plus where it goes back. A digest alone cannot restore a
 * workspace: two untracked files are indistinguishable without the path they
 * were captured from, so the path travels in the manifest rather than being
 * reconstructed from a storage key.
 */
export type WorkspaceArtifact = ObjectRef & {
  /**
   * Restored with the execute bits on. Absent rather than false, so a
   * manifest without executables keeps the digest it had before this field.
   */
  readonly executable?: true;
  /** Destination relative to the workspace root; never absolute, never `..`. */
  readonly path: string;
};

export type CheckpointWorkspace = {
  /**
   * A git bundle whose tip is `gitCommit`, stored beside the transcript parts.
   *
   * The commit travels with the checkpoint rather than being looked up in a
   * remote, because a remote answers for the branch it has *now*: a force-push,
   * a branch delete or a GC after the checkpoint was taken all turn a verified
   * commit back into an unfetchable one. Carrying the objects makes the
   * checkpoint's own durability the only thing restore depends on, and makes
   * the commit verifiable by exactly the digest check every other object gets.
   *
   * Writers must upload it with `putImmutable` and record the version it
   * answers, like every other ref: finalize verifies that version and restore
   * reads that version, so a later write to the same key cannot come between
   * the two.
   */
  readonly bundle: ObjectRef;
  /**
   * The bundles `bundle` builds on, oldest first: the first stands
   * alone, and each later one — `bundle` included — needs only commits an
   * earlier one offers as a ref tip. Absent for a bundle that stands alone.
   * They are the previous checkpoint's bundles, in the directories that
   * checkpoint wrote them to; a restore fetches them in this order before
   * `bundle`, which alone carries the refs it checks out.
   */
  readonly baseBundles?: readonly ObjectRef[];
  readonly gitCommit: string;
  /**
   * Local branches other than the snapshot, by short name, each with the
   * commit it was at: what a push request may name as its source. Absent
   * when the workspace had none, which keeps such a manifest byte for byte
   * what a build before this field wrote.
   */
  readonly sources?: ReadonlyArray<{
    readonly commit: string;
    readonly name: string;
  }>;
  /** Files git does not track, uploaded individually so restore is exact. */
  readonly untracked: readonly WorkspaceArtifact[];
};

/**
 * A file the engine left under `out/` for a person to take away, indexed
 * apart from git: a file the engine committed, or one an ignore rule hides,
 * is listed all the same. `path` is relative to the workspace root and
 * starts with `out/`. The object sits at `<publish directory>outputs/<sha256>`
 * of the checkpoint that first uploaded it; a later checkpoint names the same
 * ref rather than uploading the bytes again.
 */
export type StoredOutput = ObjectRef & { readonly path: string };

/**
 * A file under `out/` over the output limits: listed so a person learns it
 * exists, never uploaded. Its bytes were not read, so it has no digest.
 */
export type OmittedOutput = {
  readonly bytes: number;
  readonly omitted: "too_large";
  readonly path: string;
};

export type CheckpointOutput = StoredOutput | OmittedOutput;

export function storedOutputs(
  outputs: readonly CheckpointOutput[] | undefined,
): StoredOutput[] {
  return (outputs ?? []).filter(
    (output): output is StoredOutput => !("omitted" in output),
  );
}

export type CheckpointTranscripts = {
  readonly root: TranscriptRevision;
  /** Keyed by the engine's subagent subpath. */
  readonly subagents: Readonly<Record<string, TranscriptRevision>>;
};

/**
 * The most transcript one checkpoint may carry, per part and in total across
 * the root and every subagent. A restore streams the transcript to the
 * workspace volume one part at a time, so what the total is sized against is
 * the engine: resuming a transcript with no compaction in it, the engine
 * holds about twice its size, and the worker's memory
 * (`WORKER_MEMORY_MB`) is sized so that stays under half the limit. A part
 * is what the worker holds at once. The worker checks these before
 * publishing, finalize before reading any part, and a restore before
 * fetching any part — all against these same values. A session past it
 * takes no new turn (`transcript_too_large`), and its last checkpoint stays
 * the one a restore resumes.
 * Measurements, sessions per node and how to change both: apps/docs/content/docs/run-server/self-hosting/operate/capacity.mdx.
 */
export const MAX_TRANSCRIPT_PART_BYTES = 16 * 1024 * 1024;
export const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

export type TranscriptLimits = {
  readonly partBytes: number;
  readonly totalBytes: number;
};
export const TRANSCRIPT_LIMITS: TranscriptLimits = {
  partBytes: MAX_TRANSCRIPT_PART_BYTES,
  totalBytes: MAX_TRANSCRIPT_BYTES,
};

/**
 * From this total on the session is told it is nearing the limit
 * (`transcript_near_limit`), while there is still room to finish the work in
 * hand and move on to a new session.
 */
export function transcriptWarnBytes(
  limits: TranscriptLimits = TRANSCRIPT_LIMITS,
): number {
  return Math.floor(limits.totalBytes * 0.8);
}

/** Every part of the root transcript and of each subagent's. */
export function transcriptParts(
  transcripts: CheckpointTranscripts,
): ObjectRef[] {
  return [transcripts.root, ...Object.values(transcripts.subagents)].flatMap(
    (revision) => revision.parts,
  );
}

/**
 * Why a session's transcript parts are over the limits above, judged from
 * the sizes they claim — every reader holds the stored bytes to those before
 * trusting them — so nothing has to be fetched to answer.
 */
export function transcriptSizeProblem(
  parts: Iterable<{ readonly bytes: number; readonly key: string }>,
  limits: TranscriptLimits = TRANSCRIPT_LIMITS,
): TranscriptSizeProblem | undefined {
  let total = 0;
  for (const part of parts) {
    if (part.bytes > limits.partBytes) {
      return {
        reason: "transcript_part_too_large",
        detail: `transcript part ${part.key} is ${part.bytes} bytes, over the ${limits.partBytes}-byte part limit`,
      };
    }
    total += part.bytes;
  }
  return total > limits.totalBytes
    ? {
        reason: "transcript_too_large",
        detail: `the transcript is ${total} bytes, over the ${limits.totalBytes}-byte limit`,
      }
    : undefined;
}

export type TranscriptSizeProblem = {
  readonly detail: string;
  readonly reason: "transcript_part_too_large" | "transcript_too_large";
};

export function transcriptBytes(
  parts: Iterable<{ readonly bytes: number }>,
): number {
  let total = 0;
  for (const part of parts) total += part.bytes;
  return total;
}

/**
 * A request a parked turn was waiting on, as the engine asked it: the
 * arguments unredacted, which no other record keeps, so the turn that
 * resumes it can say what was asked.
 */
export type ParkedApproval = {
  readonly input: unknown;
  readonly inputHash: string;
  readonly kind: "permission" | "question";
  readonly requestId: string;
  readonly tool: string;
  readonly toolCallId: string;
};

/** What the worker carries across a park, beside the engine's transcript. */
export type WorkerCheckpointState = {
  readonly pendingApprovals: readonly ParkedApproval[];
};

export type CheckpointManifest = {
  /**
   * The worker's own check of the commits this session made and no remote
   * has (the range ending at the workspace commit), present only when it found
   * some wrong, which keeps every other manifest's bytes. request_push
   * refuses on it before a person is asked. The worker shares a container
   * with the agent, so this is advice: the push re-checks from the values
   * the server issued.
   */
  readonly attribution?: {
    readonly mismatches: readonly AttributionMismatch[];
  };
  readonly createdAt: string;
  readonly cwd: string;
  readonly engine: string;
  /**
   * Absent when the workspace had no file under `out/`, which keeps such a
   * manifest byte for byte what a build before this field wrote.
   */
  readonly outputs?: readonly CheckpointOutput[];
  /** The handle a later `mode: "resume"` config passes back to the engine. */
  readonly resume: string;
  /** Monotonic per session; the DB pointer only ever moves forward. */
  readonly revision: number;
  readonly runtime: RuntimeFingerprint;
  readonly sessionId: string;
  readonly transcripts: CheckpointTranscripts;
  /**
   * Bumped to 2 when `workspace.bundle` became required. Version 1 described a
   * manifest that pinned a commit nothing could be asked to produce, so the two
   * shapes cannot both be called 1 — a reader would have to guess which it has.
   * No version 1 manifest is decoded: nothing outside tests has ever written
   * one, since the capture path lands in.
   */
  readonly version: 2;
  /** Absent unless the turn was parked, which keeps every other manifest's bytes. */
  readonly workerState?: WorkerCheckpointState;
  readonly workspace: CheckpointWorkspace;
};

export type CompatibilityMismatch = {
  readonly expected: string;
  readonly field: "cliVersion" | "engine" | "profileSha256" | "sdkVersion";
  readonly found: string;
};

export type CompatibilityVerdict =
  | { readonly status: "compatible" }
  | {
      readonly mismatches: readonly CompatibilityMismatch[];
      readonly status: "incompatible";
    };

/**
 * Per-engine manifest serialization. The control plane holds codecs by engine
 * name and never parses manifest bytes itself, so a second runtime can define
 * its own manifest body without the platform learning its shape.
 */
export interface CheckpointCodec {
  decode(bytes: Uint8Array): CheckpointManifest;
  encode(manifest: CheckpointManifest): { bytes: Uint8Array; sha256: string };
  readonly engine: string;
  validateCompatibility(
    manifest: CheckpointManifest,
    runtime: RuntimeFingerprint,
  ): CompatibilityVerdict;
}

/**
 * `conflict` is the case that matters: a worker from a dead epoch uploading a
 * different body under a key a live worker already wrote. The store reports it
 * instead of overwriting, and the pointer never advances to it.
 */
export type PutImmutableResult =
  // `version` is the write that now holds the bytes — for `duplicate`, the
  // earlier write that already did. A writer records it in the ref it puts in
  // a manifest. Absent on a store without versions.
  | { readonly outcome: "created"; readonly version?: string }
  | { readonly outcome: "duplicate"; readonly version?: string }
  | { readonly outcome: "conflict"; readonly sha256: string };

export type PutImmutableOptions = {
  /**
   * The key names the digest of the body, so anything already under it is
   * these bytes or damage, and a write that replaced it would lose nothing.
   * The store then skips the read it otherwise makes before writing, which
   * only guards against an endpoint that ignores the create-only
   * precondition; the precondition itself still decides `created`,
   * `duplicate` and `conflict`.
   */
  readonly contentAddressed?: boolean;
};

export type ObjectHead = {
  readonly bytes: number;
  /** True when a legal hold keeps this version from being deleted. */
  readonly held?: boolean;
  /** The version that answered; absent on a store without versions. */
  readonly version?: string;
};

/**
 * A `putImmutable` body read from somewhere else — a workspace bundle on
 * disk — rather than held. Size and digest come first: a store sends the
 * length ahead of the body, and tells a duplicate from a conflict without
 * reading the body twice.
 */
export type ImmutableObjectSource = {
  readonly bytes: number;
  /** Hex sha256 of exactly the bytes `open` yields. */
  readonly sha256: string;
  /**
   * A fresh pass over the same bytes on every call, so a store can retry.
   * Chunks may be refilled like `stream`'s; a store copies what it keeps.
   */
  open(): AsyncIterable<Uint8Array>;
};

export function isImmutableObjectSource(
  body: Uint8Array | ImmutableObjectSource,
): body is ImmutableObjectSource {
  return !(body instanceof Uint8Array);
}

/**
 * The store answered, but the bytes failed the transfer's own integrity check
 * (S3's response checksum): what arrived is not what is stored. Damage, as a
 * digest mismatch is, whatever shape the transport reported it in.
 */
export class ObjectIntegrityError extends Error {
  constructor(
    readonly key: string,
    options?: ErrorOptions,
  ) {
    super(`${key} arrived damaged: it fails the store's own checksum`, options);
    this.name = "ObjectIntegrityError";
  }
}

export interface CheckpointObjectStore {
  /**
   * With `version`, that exact write or undefined if the store no longer has
   * it; without, whatever the key holds now.
   */
  get(key: string, version?: string): Promise<Uint8Array | undefined>;
  /**
   * `get` for a body too large to hold: presence is settled before the
   * promise resolves, by the same rules as `get`, and the chunks arrive as
   * the store delivers them. A chunk is valid only until the next one is
   * asked for — a store may refill the same buffer — so a consumer that needs
   * bytes later copies them. One pass only. A consumer that stops early must
   * end the iteration (`break` in `for await` does), which releases the
   * connection.
   */
  stream(
    key: string,
    version?: string,
  ): Promise<AsyncIterable<Uint8Array> | undefined>;
  /** Size and presence without transferring the body; undefined when absent. */
  head(key: string, version?: string): Promise<ObjectHead | undefined>;
  list(prefix: string): Promise<string[]>;
  /**
   * Create-only write. Never replaces an object that already exists. A body
   * too large to hold is passed as an `ImmutableObjectSource` and streamed.
   */
  putImmutable(
    key: string,
    body: Uint8Array | ImmutableObjectSource,
    options?: PutImmutableOptions,
  ): Promise<PutImmutableResult>;
  /**
   * Places a legal hold on one version: nobody can delete it until the hold
   * is released, whatever their other permissions say. Idempotent. Only a
   * store with versions and Object Lock offers it; the control plane calls it
   * on everything a checkpoint it commits names. Whoever holds the permission
   * to place a hold can also release one, so workers must not have it: they
   * reach the store only through the object store route, which never signs
   * a hold.
   */
  hold?(key: string, version: string): Promise<void>;
}

/**
 * The transcript entry shape as a store adapter sees it: a `type` discriminant,
 * usually a `uuid`, and otherwise opaque JSON that must survive a
 * stringify/parse round trip untouched.
 */
export type TranscriptEntry = {
  readonly [key: string]: unknown;
  readonly type: string;
  readonly uuid?: string;
};

export type TranscriptKey = {
  readonly projectKey: string;
  readonly sessionId: string;
  /** Absent for the root transcript; set for a subagent's. */
  readonly subpath?: string;
};

/**
 * Structural supertype of the engine SDK's session-store port. Declared here so
 * store implementations stay outside the module that imports the SDK.
 */
export interface TranscriptMirror {
  append(key: TranscriptKey, entries: TranscriptEntry[]): Promise<void>;
  /**
   * True when `load` answers with exactly the parts a committed checkpoint
   * pinned, rather than everything the mirror currently holds — as of the
   * moment a resumed engine reads it, before anything new is appended.
   *
   * A plain mirror is deliberately not revision-scoped: it keeps recording
   * after a checkpoint, and those entries are not part of it. Handing such a
   * mirror to a resumed engine replays a conversation that was never
   * committed, so a resume refuses a mirror that does not declare this.
   */
  readonly revisionScoped?: boolean;
  listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]>;
  load(key: TranscriptKey): Promise<TranscriptEntry[] | null>;
  /**
   * For a mirror that wrote the resumed transcript to the engine's own disk
   * and so answers the engine's `load` with null: the root transcript's entry
   * uuids, which that `load` would otherwise have returned.
   */
  resumedEntryIds?(): ReadonlySet<string> | undefined;
  /** The same mirror's answer for the running cost the transcript saved last. */
  resumedSavedCost?(): SavedCost | undefined;
}

/**
 * The running cost an engine saved in a transcript, and the session it
 * belongs to. A resumed engine continues its totals from it.
 */
export type SavedCost = {
  readonly sessionId?: string;
  readonly usd: number;
};

/**
 * The layout every transcript mirror shares under a session's object prefix
 * `<session prefix>transcripts/generation-<n>/…`, one directory per
 * execution generation, which writes nowhere else. The control plane reads a
 * part's generation back from its key to reclaim what a generation left once
 * it can no longer commit, so the layout is a contract between the
 * mirror and the control plane rather than an adapter's detail.
 */
export const TRANSCRIPT_MIRROR_DIRECTORY = "transcripts";

export function transcriptGenerationDirectory(generation: number): string {
  return `generation-${String(generation).padStart(10, "0")}`;
}

/**
 * The execution generation that wrote a key under the session's transcript
 * mirror; undefined for any key outside it or not in a generation directory.
 */
export function transcriptGenerationOf(
  key: string,
  sessionPrefix: string,
): number | undefined {
  const mirror = `${sessionPrefix}${TRANSCRIPT_MIRROR_DIRECTORY}/`;
  if (!key.startsWith(mirror)) return undefined;
  const match = /^generation-(\d{10})\//.exec(key.slice(mirror.length));
  return match?.[1] === undefined ? undefined : Number(match[1]);
}
