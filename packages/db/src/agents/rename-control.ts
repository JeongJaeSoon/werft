import type {
  RenameSessionInput,
  RenameSessionResult,
} from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import {
  actorStillMember,
  controlClock,
  lockSessionForControl,
  transactionWithBindingRetry,
} from "../control-shared.ts";
import { dbNow } from "../db-clock.ts";
import { awaitingInputAt, publicStatus } from "../decision/pending-status.ts";
import type { Database } from "../queries.ts";
import { sessions } from "../schema.ts";
import { recordStatus } from "../sessions/session-events.ts";

export function renameAtomic(
  db: Database,
  input: RenameSessionInput,
): Promise<RenameSessionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const startedAt = Date.now();
  return transactionWithBindingRetry(db, async (tx, attempt) => {
    if (!(await actorStillMember(tx, input.principal))) {
      return { outcome: "actor_inactive" };
    }
    // The events writer's lock: the status event below takes its id under it.
    const session = await lockSessionForControl(tx, {
      sessionId,
      ownerId: input.principal.ownerId,
      attempt,
    });
    if (!session) return { outcome: "not_found" };
    const now = controlClock(input.now, startedAt);
    // Kept as the user's even when it matches: a generated title arriving
    // after this must not replace a title the user confirmed.
    if (session.title === input.title) {
      if (session.titleSource !== "user") {
        await tx
          .update(sessions)
          .set({ titleSource: "user" })
          .where(eq(sessions.id, sessionId));
      }
      return { outcome: "renamed", changed: false };
    }
    await tx
      .update(sessions)
      .set({ title: input.title, titleSource: "user", updatedAt: now })
      .where(eq(sessions.id, sessionId));
    const at = await dbNow(tx);
    await recordStatus(tx, {
      sessionId,
      phase: publicStatus(
        session.status,
        await awaitingInputAt(tx, sessionId, at),
      ),
      extra: {
        admission_state: session.admissionState,
        title: input.title,
        actor: { owner_id: input.principal.ownerId },
      },
      turnRowId: null,
      now,
    });
    return { outcome: "renamed", changed: true };
  });
}
