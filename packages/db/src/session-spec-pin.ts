import {
  type ReleaseSpecRecord,
  releaseSpecRecord,
  verifyReleaseSpec,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import type { Database } from "./queries.ts";

/** The four `sessions` spec columns, written together (`sessions_spec_check`). */
export type SessionSpecPin = {
  specSource: ReleaseSpecRecord["spec_source"];
  specSourceDigest: string;
  runtimeSpec: ReleaseSpecRecord["runtime_spec"];
  specDigest: string;
};

function pinOf(record: ReleaseSpecRecord): SessionSpecPin {
  return {
    specSource: record.spec_source,
    specSourceDigest: record.spec_source_digest,
    runtimeSpec: record.runtime_spec,
    specDigest: record.spec_digest,
  };
}

/**
 * The release's verified spec with the session's model in place of the
 * release's. The release stays as it is; `release_id` still names it, so the
 * pair verifies against the release id like the release's own. Null when the
 * release has no spec that verifies: such a session is left unpinned for the
 * reconciliation to count, never guessed.
 */
export function sessionPinFromRelease(
  releaseId: string,
  stored: {
    spec_source: unknown;
    runtime_spec: unknown;
    spec_source_digest: unknown;
    spec_digest: unknown;
  },
  model: string | null,
): SessionSpecPin | null {
  const verdict = verifyReleaseSpec(releaseId, stored);
  if (!verdict.ok) return null;
  const { spec_source: source } = verdict.record;
  if (model === null || model === source.model) return pinOf(verdict.record);
  return pinOf(releaseSpecRecord({ ...source, model }));
}

/** The pin a new session starts with, read under the creating transaction. */
export async function newSessionPin(
  tx: Database,
  releaseId: string,
  model: string | null,
): Promise<SessionSpecPin | null> {
  const [row] = rowsOf<{
    spec_source: unknown;
    runtime_spec: unknown;
    spec_source_digest: unknown;
    spec_digest: unknown;
  }>(
    await tx.execute(sql`
      SELECT spec_source, runtime_spec, spec_source_digest, spec_digest
      FROM agent_releases WHERE id = ${releaseId}`),
  );
  return row === undefined
    ? null
    : sessionPinFromRelease(releaseId, row, model);
}

/**
 * The pin a session holds after its model moves. A session with no pin, or one
 * that no longer verifies, stays as it is: the reconciliation repairs it.
 */
export async function movedSessionPin(
  tx: Database,
  sessionId: string,
  model: string,
): Promise<SessionSpecPin | null> {
  const [row] = rowsOf<{
    release_id: string | null;
    spec_source: unknown;
    runtime_spec: unknown;
    spec_source_digest: unknown;
    spec_digest: unknown;
  }>(
    await tx.execute(sql`
      SELECT agent_release_id AS release_id, spec_source, runtime_spec,
             spec_source_digest, spec_digest
      FROM sessions WHERE id = ${sessionId}`),
  );
  if (row === undefined || row.release_id === null) return null;
  if (row.spec_source === null) return null;
  return sessionPinFromRelease(row.release_id, row, model);
}
