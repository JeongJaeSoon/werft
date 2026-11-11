import { randomUUID } from "node:crypto";
import type {
  ChangeProfileReceiptResult,
  ControlAcceptedResponse,
} from "@werft-ai/contracts";
import {
  type ChangeProfileInput,
  type ChangeProfileResult,
  PROFILE_CHANGE_ADMISSION_STATES,
} from "@werft-ai/platform";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  controlClock,
  controlReplay,
  findIdempotent,
  type IdempotencyScope,
  lockIdempotencyScope,
  lockSessionForControl,
  receiptActorOf,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { dbNow } from "./db-clock.ts";
import { awaitingInputAt, publicStatus } from "./decision/pending-requests.ts";
import type { Database } from "./queries.ts";
import {
  attempts,
  checkpoints,
  idempotencyKeys,
  receipts,
  sessions,
} from "./schema.ts";
import { recordStatus } from "./sessions/session-events.ts";

export const CHANGE_PROFILE = "change_profile";

type Allowed = (typeof PROFILE_CHANGE_ADMISSION_STATES)[number];

function allowed(state: string): state is Allowed {
  return (PROFILE_CHANGE_ADMISSION_STATES as readonly string[]).includes(state);
}

/**
 * Only the session row moves: claims match it, so the next attempt runs the
 * new profile. A bound attempt keeps the profile it claimed (attempts row)
 * for the turn it holds and is then handed no more input; the checkpoints
 * it commits carry its profile, which is what a later restore is checked
 * against.
 */
export function changeProfileAtomic(
  db: Database,
  input: ChangeProfileInput,
): Promise<ChangeProfileResult> {
  const sessionId = input.sessionId.toLowerCase();
  const scope: IdempotencyScope = {
    principal: input.principal.ownerId,
    actor: receiptActorOf(input.principal),
    requestId: input.principal.requestId ?? null,
    operation: CHANGE_PROFILE,
    resource: sessionId,
    key: input.idempotencyKey,
  };
  const startedAt = Date.now();

  return transactionWithBindingRetry(db, async (tx, attempt) => {
    await lockIdempotencyScope(tx, scope);
    const existing = await findIdempotent(tx, scope);
    const replay = controlReplay(existing, input.payloadHash);
    if (replay) return replay;
    const session = await lockSessionForControl(tx, {
      sessionId,
      ownerId: scope.principal,
      attempt,
    });
    if (!session) return { outcome: "not_found" };
    const now = controlClock(input.now, startedAt);
    if (session.admissionState === "closed") {
      return { outcome: "rejected", admissionState: "closed" };
    }
    if (
      session.revision !== input.expectedRevision ||
      session.profileId !== input.judgedFrom
    ) {
      return {
        outcome: "revision_conflict",
        currentRevision: session.revision,
      };
    }
    const state = session.admissionState;
    if (!allowed(state)) return { outcome: "rejected", admissionState: state };
    if (session.agentReleaseId !== null) {
      return { outcome: "release_bound", releaseId: session.agentReleaseId };
    }
    const { profile } = input;
    if (profile === null) return { outcome: "unsupported" };
    if (session.unmetered !== profile.unmetered) {
      return { outcome: "billing_mismatch" };
    }

    const unchanged =
      session.profileId === profile.id &&
      session.profileFingerprint === profile.fingerprint &&
      session.model === profile.model;
    if (!unchanged) {
      // Rows an older build wrote during a rollout name no profile, and rows
      // 0147 copied from a session older than its fingerprint name no
      // fingerprint; they ran the profile being replaced, and say so before
      // it stops being the session's.
      const was = {
        profileId: session.profileId,
        profileFingerprint: session.profileFingerprint,
        model: session.model,
      };
      const ranProfile = (
        column: typeof attempts.profileId | typeof checkpoints.profileId,
      ) =>
        session.profileId === null
          ? isNull(column)
          : or(isNull(column), eq(column, session.profileId));
      await tx
        .update(attempts)
        .set(was)
        .where(
          and(
            eq(attempts.sessionId, sessionId),
            isNull(attempts.profileFingerprint),
            ranProfile(attempts.profileId),
          ),
        );
      await tx
        .update(checkpoints)
        .set(was)
        .where(
          and(
            eq(checkpoints.sessionId, sessionId),
            isNull(checkpoints.profileFingerprint),
            ranProfile(checkpoints.profileId),
          ),
        );
      await tx
        .update(sessions)
        .set({
          profileId: profile.id,
          profileFingerprint: profile.fingerprint,
          model: profile.model,
          revision: sql`${sessions.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(sessions.id, sessionId));
    }

    const result: ChangeProfileReceiptResult = {
      previous_profile_id: session.profileId,
      profile_id: profile.id,
    };
    const receiptId = randomUUID();
    const response: ControlAcceptedResponse = {
      receipt_id: receiptId,
      receipt_status: "succeeded",
    };
    await tx.insert(receipts).values({
      id: receiptId,
      ownerId: scope.principal,
      actor: scope.actor,
      requestId: scope.requestId,
      operation: CHANGE_PROFILE,
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: response.receipt_status,
      result,
    });
    await tx.insert(idempotencyKeys).values({
      principal: scope.principal,
      operation: scope.operation,
      resource: scope.resource,
      key: scope.key,
      payloadHash: input.payloadHash,
      receiptId,
    });
    if (!unchanged) {
      const at = await dbNow(tx);
      await recordStatus(tx, {
        sessionId,
        phase: publicStatus(
          session.status,
          await awaitingInputAt(tx, sessionId, at),
        ),
        extra: {
          admission_state: state,
          ...result,
          actor: { owner_id: input.principal.ownerId },
        },
        turnRowId: null,
        now,
      });
    }
    return { outcome: "accepted", response };
  });
}
