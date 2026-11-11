import { digestParts } from "@werft-ai/runtime-codec-kit";
import type { ObjectRef } from "@werft-ai/runtime-core";

// Both engines digest a revision's parts with the same shared codec kit, so
// the two entries are one function; each engine still names its own.
const transcriptDigests = new Map<
  string,
  (parts: readonly ObjectRef[]) => string
>([
  ["claude", digestParts],
  ["codex", digestParts],
]);

/** How the codec of `engine` digests a transcript revision's parts, for fixtures that build one. */
export function transcriptDigestFor(
  engine: string,
): (parts: readonly ObjectRef[]) => string {
  const digest = transcriptDigests.get(engine);
  if (digest === undefined) {
    throw new Error(`No checkpoint codec is installed for ${engine}`);
  }
  return digest;
}
