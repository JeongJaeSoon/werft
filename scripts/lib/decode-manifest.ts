/**
 * Decodes one checkpoint manifest file with the production codec, so
 * scripts/verify-restore.sh judges a restored manifest by the same rules the
 * control plane applies at resume: schema, digest formats, and each
 * transcript revision's part-list digest. Prints nothing on success; on
 * failure prints the codec's reason and exits 1.
 *
 *   bun run scripts/lib/decode-manifest.ts <manifest.json>
 */

import { readFile } from "node:fs/promises";
import { claudeCheckpointCodec } from "@werft-ai/runtime-claude-codec";
import { messageOf } from "@werft-ai/runtime-core";

const path = process.argv[2];
if (!path) {
  console.error("usage: decode-manifest.ts <manifest.json>");
  process.exit(2);
}
try {
  claudeCheckpointCodec.decode(new Uint8Array(await readFile(path)));
} catch (error) {
  console.error(messageOf(error));
  process.exit(1);
}
