import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { messageOf } from "@werft-ai/platform";
import type { PassLoopLogger } from "../pass-loop/loop.ts";

/**
 * Handed by the scheduler loop to its passes: where they note the settings
 * the workspace quota preflight passed under. A pass run on its own
 * has none and always probes; only the loop, which removes the file when it
 * starts, can vouch that the daemon is the one the note was made against.
 */
export const QUOTA_PREFLIGHT_MARKER_ENV = "SCHEDULER_QUOTA_PREFLIGHT_MARKER";

/**
 * Runs `verify` unless a pass of this loop already passed it on the same
 * `settings`. The probe is a volume and a CAP_SYS_ADMIN helper, several
 * Docker round trips; repeated every few seconds on settings the daemon
 * already answered for, it only spends the pass budget. A failure notes
 * nothing, so the next pass probes again.
 */
export async function verifyWorkspaceQuotaOnce(input: {
  marker: string | undefined;
  settings: unknown;
  verify: () => Promise<void>;
  logger: Pick<PassLoopLogger, "warn">;
}): Promise<void> {
  const { marker } = input;
  if (marker === undefined) return input.verify();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(input.settings))
    .digest("hex");
  const noted = await readFile(marker, "utf8").catch(() => null);
  if (noted === fingerprint) return;
  await input.verify();
  await writeFile(marker, fingerprint).catch((error: unknown) => {
    input.logger.warn(
      "Workspace quota preflight passed but could not be noted; the next pass probes again",
      {
        error: messageOf(error),
        path: marker,
      },
    );
  });
}
