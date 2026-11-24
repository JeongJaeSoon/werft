import {
  JUDGMENT_INSTRUCTIONS_MAX_BYTES,
  type ReceiptActor,
  type ReleaseInstructions,
  type RuntimeKind,
} from "@werft-ai/contracts";
import {
  type CommittedTree,
  namedCommittedInstructions,
} from "@werft-ai/runtime-core";

type ReadFailure = Extract<
  ReleaseInstructions,
  { kind: "read_failed" }
>["reason"];

/** Who makes the release the file is read for: its token's receipt names them. */
export type ReleaseInstructionsReader = {
  /** The release's workspace. */
  ownerId: string;
  agentId: string;
  actor: ReceiptActor | null;
};

/** A catalog repository's branch as it is now, to read one file from. */
export interface ReleaseInstructionsSource {
  /**
   * The commit the repository's branch is at now, the tree at that commit
   * (whose reads throw when the forge fails), and the instruction file names
   * `runtime` reads, in its order.
   */
  open(
    repositoryId: string,
    runtime: RuntimeKind,
    reader: ReleaseInstructionsReader,
  ): Promise<
    | {
        kind: "tree";
        commit: string;
        files: readonly string[];
        tree: CommittedTree;
      }
    | { kind: "read_failed"; reason: ReadFailure }
  >;
}

/** Past this a read counts as failed, so making a release never hangs on it. */
export const RELEASE_INSTRUCTIONS_READ_MS = 10_000;

const encoder = new TextEncoder();
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/** The longest start of `text` within `limit` UTF-8 bytes, never splitting a character. */
export function cutToBytes(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const { segment } of graphemes.segment(text)) {
    bytes += encoder.encode(segment).length;
    if (bytes > limit) break;
    end += segment.length;
  }
  return text.slice(0, end);
}

/**
 * The release's instruction snapshot: the file read once now, at the commit
 * the branch is at, cut to what a judgment reads. Never throws: a read that
 * fails is `read_failed`, and the release is made without the file.
 */
export async function snapshotReleaseInstructions(
  source: ReleaseInstructionsSource,
  repositoryId: string | null,
  runtime: RuntimeKind,
  reader: ReleaseInstructionsReader,
  timeoutMs = RELEASE_INSTRUCTIONS_READ_MS,
): Promise<ReleaseInstructions> {
  if (repositoryId === null) return { kind: "no_repository" };
  const failed = (reason: ReadFailure): ReleaseInstructions => ({
    kind: "read_failed",
    repository_id: repositoryId,
    reason,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const read = async (): Promise<ReleaseInstructions> => {
    const opened = await source.open(repositoryId, runtime, reader);
    if (opened.kind === "read_failed") return failed(opened.reason);
    const { commit } = opened;
    const { file, found } = await namedCommittedInstructions(
      opened.tree,
      opened.files,
    );
    switch (found.kind) {
      case "absent":
        return { kind: "absent", repository_id: repositoryId, commit };
      case "refused":
        return {
          kind: "refused",
          repository_id: repositoryId,
          commit,
          reason: found.reason,
        };
      case "text": {
        const bytes = encoder.encode(found.text).length;
        return {
          kind: "text",
          repository_id: repositoryId,
          commit,
          file: file ?? "",
          text: cutToBytes(found.text, JUDGMENT_INSTRUCTIONS_MAX_BYTES),
          bytes,
          truncated: bytes > JUDGMENT_INSTRUCTIONS_MAX_BYTES,
        };
      }
    }
  };
  try {
    const result = await Promise.race([read(), timedOut]);
    return result === "timeout" ? failed("github_failed") : result;
  } catch {
    // The source logs what went wrong; the release only needs to say so.
    return failed("github_failed");
  } finally {
    clearTimeout(timer);
  }
}
