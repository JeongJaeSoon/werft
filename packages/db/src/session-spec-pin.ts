import {
  type ReleaseSpecRecord,
  releaseSpecRecord,
  verifyReleaseSpec,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { rowsOf } from "./statement-rows.ts";

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
 * release's. The release stays as it is. Null when the stored spec does not
 * verify: such a session is not given a guessed one.
 */
export function sessionPinFromRelease(
  stored: {
    spec_source: unknown;
    runtime_spec: unknown;
    spec_source_digest: unknown;
    spec_digest: unknown;
  },
  model: string | null,
): SessionSpecPin | null {
  const verdict = verifyReleaseSpec(stored);
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
  return row === undefined ? null : sessionPinFromRelease(row, model);
}

/**
 * The pin a session holds after its model moves. A session with no pin, or one
 * that no longer verifies, stays as it is.
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
  return sessionPinFromRelease(row, model);
}

/**
 * True when the session, brought back to a live status, would break the rule
 * `sessions_pin_required` enforces: a release, a pin, and a pin on the
 * session's own model. A caller that reactivates a stopped session asks
 * first, so it can refuse in its own words instead of failing on the trigger.
 */
export function pinRefusesLive(session: {
  agentReleaseId: string | null;
  runtimeSpec: Record<string, unknown> | null;
  model: string | null;
}): boolean {
  return (
    session.agentReleaseId === null ||
    session.runtimeSpec === null ||
    (session.runtimeSpec.model ?? null) !== session.model
  );
}
