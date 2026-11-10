import type {
  CheckpointObjectStore,
  CheckpointTranscripts,
  TranscriptLimits,
  TranscriptMirror,
  TranscriptSizeProblem,
} from "./checkpoint-manifest.ts";

/**
 * What a resumed launch adopts: the transcripts of the checkpoint it resumes,
 * exactly as that manifest pinned them.
 */
export type TranscriptInheritance = {
  /** The engine session being resumed — the manifest's `resume`. */
  readonly sessionId: string;
  readonly transcripts: CheckpointTranscripts;
};

export type TranscriptStoreOptions = {
  readonly objects: CheckpointObjectStore;
  /** Key namespace; one session's transcripts never share it with another. */
  readonly prefix: string;
  /** The execution generation this launch runs as; it writes nowhere else. */
  readonly generation: number;
  /** Absent for a session that has never been checkpointed. */
  readonly inherit?: TranscriptInheritance;
  /** `TRANSCRIPT_LIMITS` unless a test sets smaller ones. */
  readonly transcriptLimits?: TranscriptLimits;
  /**
   * The directory the host keeps the engine's transcripts in, on the volume
   * a checkpoint restores to (what `materialize` is later given). A store
   * whose engine writes its transcript to disk itself reads it from here.
   */
  readonly engineDirectory?: string;
};

/**
 * What a checkpoint needs of an engine's transcripts: pin them as exact
 * revisions, check what a restore adopts, and write it back where the engine
 * resumes from. How the engine's transcript gets to the store is the engine's
 * own business (`TranscriptStore.mirror`).
 */
export interface TranscriptCapture {
  /** When an append last landed; null before the first. */
  readonly persistedAt: Date | null;
  /** True while a transcript's latest append failed and nothing has landed for it since. */
  readonly unsettled: boolean;
  /** Settles once this launch owns its generation; rejects when another launch wrote there. */
  ready(): Promise<void>;
  /** Fetches and checks every adopted part, so a restore refuses a transcript that is gone or edited. */
  verifyInherited(signal?: AbortSignal): Promise<void>;
  /**
   * Writes the adopted transcripts under `engineDirectory`, the directory the
   * engine resumes them from, in the layout the engine reads.
   */
  materialize(engineDirectory: string, signal?: AbortSignal): Promise<void>;
  /** Pins the session's transcripts; throws `TranscriptTooLargeError` past the limits. */
  captureTranscripts(sessionId: string): Promise<CheckpointTranscripts | null>;
  /** The size of every part a capture of `sessionId` would pin; null without a root transcript. */
  transcriptSizes(
    sessionId: string,
  ): Promise<Array<{ bytes: number; key: string }> | null>;
}

/**
 * An engine's transcript store. `mirror` is present for an engine that hands
 * its transcript over entry by entry while it runs (Claude's session store);
 * an engine that keeps its transcript on disk and is read at the checkpoint
 * has none.
 */
export interface TranscriptStore extends TranscriptCapture {
  readonly mirror?: TranscriptMirror;
}

/**
 * A capture refused because the transcript is past the limits a checkpoint
 * carries (`MAX_TRANSCRIPT_BYTES`), before anything was merged or written.
 */
export class TranscriptTooLargeError extends Error {
  override readonly name = "TranscriptTooLargeError";
  readonly reason: TranscriptSizeProblem["reason"];
  constructor(problem: TranscriptSizeProblem) {
    super(problem.detail);
    this.reason = problem.reason;
  }
}
