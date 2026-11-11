import { deriveSessionTitle, type SessionTitleStore } from "@werft-ai/platform";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  lockSessionForControl,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { DB_NOW, dbNow, fromDbNow } from "./db-clock.ts";
import { awaitingInputAt, publicStatus } from "./decision/pending-requests.ts";
import type { Database } from "./queries.ts";
import { sessions, sessionTitleRequests, turns } from "./schema.ts";
import { recordStatus } from "./sessions/session-events.ts";

export function createPostgresSessionTitleStore(
  db: Database,
): SessionTitleStore {
  return {
    issueAtomic(input) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            title: sessions.title,
            titleSource: sessions.titleSource,
            authRevision: sessions.authRevision,
            profileId: sessions.profileId,
            profileFingerprint: sessions.profileFingerprint,
            model: sessions.model,
            message: turns.message,
            status: turns.status,
            resultJson: turns.resultJson,
            attemptId: turns.attemptId,
          })
          .from(sessions)
          .innerJoin(
            turns,
            and(eq(turns.sessionId, sessions.id), eq(turns.sequence, 1)),
          )
          .where(eq(sessions.id, input.sessionId))
          .limit(1);
        if (
          !row ||
          row.titleSource !== "derived" ||
          // A title that is not the one cut from this message was renamed,
          // by an API from before title_source.
          row.title !== deriveSessionTitle(row.message) ||
          row.status !== "completed" ||
          row.attemptId !== input.attemptId
        ) {
          return { outcome: "skipped" };
        }
        const inserted = await tx
          .insert(sessionTitleRequests)
          .values({
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            tokenHash: input.tokenHash,
            authRevision: row.authRevision,
            issuedTitle: row.title,
            expiresAt: fromDbNow(input.ttlMs),
          })
          .onConflictDoNothing({ target: sessionTitleRequests.sessionId })
          .returning({ sessionId: sessionTitleRequests.sessionId });
        if (inserted.length === 0) return { outcome: "skipped" };
        return {
          outcome: "issued",
          message: row.message,
          result: resultTextOf(row.resultJson),
          profileId: row.profileId,
          profileFingerprint: row.profileFingerprint,
          model: row.model,
        };
      });
    },

    // Claims the token: the proxy asks again for the same exchange after 30s
    // and is refused then, so one token buys one exchange that must finish
    // before that.
    authorizeAtomic(input) {
      return db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(sessionTitleRequests)
          .set({ claimedAt: DB_NOW })
          .where(
            and(
              eq(sessionTitleRequests.tokenHash, input.tokenHash),
              isNull(sessionTitleRequests.claimedAt),
              isNull(sessionTitleRequests.settledAt),
              gt(sessionTitleRequests.expiresAt, DB_NOW),
            ),
          )
          .returning({
            sessionId: sessionTitleRequests.sessionId,
            attemptId: sessionTitleRequests.attemptId,
            issuedRevision: sessionTitleRequests.authRevision,
          });
        if (!claimed) return { outcome: "invalid_token" };
        const [session] = await tx
          .select({
            authRevision: sessions.authRevision,
            executionRevokedAt: sessions.executionRevokedAt,
            profileId: sessions.profileId,
            profileFingerprint: sessions.profileFingerprint,
            model: sessions.model,
            costUsd: sessions.costUsd,
            providerTokens: sessions.providerTokens,
          })
          .from(sessions)
          .where(eq(sessions.id, claimed.sessionId))
          .limit(1);
        if (
          !session ||
          claimed.issuedRevision !== session.authRevision ||
          session.executionRevokedAt !== null
        ) {
          return { outcome: "invalid_token" };
        }
        return {
          outcome: "ok",
          sessionId: claimed.sessionId,
          attemptId: claimed.attemptId,
          profileId: session.profileId,
          profileFingerprint: session.profileFingerprint,
          model: session.model,
          costUsd: session.costUsd,
          providerTokens: session.providerTokens,
        };
      });
    },

    settleAtomic(input) {
      return transactionWithBindingRetry(db, async (tx, attempt) => {
        const [request] = await tx
          .select({
            sessionId: sessionTitleRequests.sessionId,
            settledAt: sessionTitleRequests.settledAt,
            issuedTitle: sessionTitleRequests.issuedTitle,
          })
          .from(sessionTitleRequests)
          .where(eq(sessionTitleRequests.tokenHash, input.tokenHash))
          .limit(1)
          .for("update");
        if (!request || request.settledAt !== null) return { outcome: "kept" };
        await tx
          .update(sessionTitleRequests)
          .set({ settledAt: input.now })
          .where(eq(sessionTitleRequests.sessionId, request.sessionId));
        if (input.title === null) return { outcome: "kept" };
        // The events writer's lock, as a rename takes it: whichever of the
        // two commits second sees the other's title_source.
        const session = await lockSessionForControl(tx, {
          sessionId: request.sessionId,
          attempt,
        });
        if (
          !session ||
          session.titleSource !== "derived" ||
          session.title !== request.issuedTitle
        ) {
          return { outcome: "kept" };
        }
        await tx
          .update(sessions)
          .set({
            title: input.title,
            titleSource: "generated",
            updatedAt: input.now,
          })
          .where(eq(sessions.id, request.sessionId));
        if (session.title !== input.title) {
          const at = await dbNow(tx);
          await recordStatus(tx, {
            sessionId: request.sessionId,
            phase: publicStatus(
              session.status,
              await awaitingInputAt(tx, request.sessionId, at),
            ),
            extra: {
              admission_state: session.admissionState,
              title: input.title,
            },
            turnRowId: null,
            now: input.now,
          });
        }
        return { outcome: "applied" };
      });
    },
  };
}

export function resultTextOf(resultJson: unknown): string | null {
  if (typeof resultJson !== "object" || resultJson === null) return null;
  const { result } = resultJson as { result?: unknown };
  return typeof result === "string" ? result : null;
}
