import type { PushRequestFlow } from "@werft-ai/contracts";
import type { PushFollowUpStore } from "@werft-ai/platform";
import { and, eq, max, or, sql } from "drizzle-orm";
import { enqueueWithin } from "./enqueue.ts";
import type { Database } from "./queries.ts";
import {
  pullRequests,
  pushFollowUps,
  pushRequests,
  sessions,
  turns,
} from "./schema.ts";

export type PushFollowUpHold = "now" | "held" | "pull_request";

async function pullRequestRecorded(
  tx: Database,
  sessionId: string,
  pushRequestId: string,
): Promise<boolean> {
  const [push] = await tx
    .select({
      repositoryId: pushRequests.repositoryId,
      targetBranch: pushRequests.targetBranch,
    })
    .from(pushRequests)
    .where(eq(pushRequests.id, pushRequestId));
  if (push === undefined) return false;
  const [found] = await tx
    .select({ url: pullRequests.url })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.sessionId, sessionId),
        or(
          eq(pullRequests.pushRequestId, pushRequestId),
          and(
            eq(pullRequests.repositoryId, push.repositoryId),
            eq(pullRequests.head, push.targetBranch),
          ),
        ),
      ),
    )
    .limit(1);
  return found !== undefined;
}

/**
 * Decides, under the session lock finalize also takes, what becomes of an
 * approved push's follow-up turn: `pull_request` when the push's branch
 * already has one recorded (nothing to ask for), `held` when a turn is
 * running (it may open the pull request itself; the next turn end decides),
 * `now` when the caller should queue it at once.
 */
const LEGACY_FOLLOW_UP =
  /^Platform note: a person (approved|rejected) (push request \S+ \(repository [^,]+, branch [^)]+\))/;

/**
 * Rows held before the wording became facts carry directives; the held text
 * is what the turn will say, so it is rewritten when it is queued.
 */
export function followUpFact(message: string): string {
  const legacy = LEGACY_FOLLOW_UP.exec(message);
  if (legacy === null) return message;
  const [, verb, subject] = legacy;
  return `A person ${verb} ${subject}. ${
    verb === "approved"
      ? "The push runs in the background."
      : "Nothing was pushed."
  }`;
}

export function holdPushFollowUp(
  db: Database,
  input: { sessionId: string; pushRequestId: string; message: string },
): Promise<PushFollowUpHold> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .for("update");
    if (await pullRequestRecorded(tx, input.sessionId, input.pushRequestId)) {
      return "pull_request";
    }
    const [running] = await tx
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(eq(turns.sessionId, input.sessionId), eq(turns.status, "running")),
      )
      .limit(1);
    if (running === undefined) return "now";
    await tx.insert(pushFollowUps).values(input).onConflictDoNothing();
    return "held";
  });
}

/**
 * Called in the finalize transaction of any turn that did not park, under
 * the session lock: queues each held follow-up whose push's branch still has
 * no pull request, and drops the hold either way. A paused, closing or
 * recovering session keeps its holds for a later turn end.
 */
export async function queuePushFollowUps(
  tx: Database,
  input: { session: typeof sessions.$inferSelect },
): Promise<number> {
  const { session } = input;
  if (
    session.admissionState !== "active" ||
    session.takeoverRequiredAt !== null
  ) {
    return 0;
  }
  const held = await tx
    .delete(pushFollowUps)
    .where(eq(pushFollowUps.sessionId, session.id))
    .returning();
  let queued = 0;
  for (const hold of held) {
    if (await pullRequestRecorded(tx, session.id, hold.pushRequestId)) {
      continue;
    }
    const message = followUpFact(hold.message);
    const [last] = await tx
      .select({ sequence: max(turns.sequence) })
      .from(turns)
      .where(eq(turns.sessionId, session.id));
    const [turn] = await tx
      .insert(turns)
      .values({
        sessionId: session.id,
        sequence: (last?.sequence ?? 0) + 1,
        message,
        status: "queued",
        createdAt: sql`clock_timestamp()`,
        actorId: null,
      })
      .returning({ id: turns.id });
    if (!turn) throw new Error("Failed to insert the push follow-up turn");
    await enqueueWithin(tx, {
      sessionId: session.id,
      turnId: turn.id,
      payload: { message },
    });
    queued += 1;
  }
  return queued;
}

export function createPostgresPushFollowUpStore(
  db: Database,
): PushFollowUpStore {
  return {
    hold: (input) => holdPushFollowUp(db, input),
    async flowOf({ sessionId, pushRequestId }) {
      const [row] = await db
        .select({ flow: pushRequests.flow })
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.id, pushRequestId),
            eq(pushRequests.sessionId, sessionId),
          ),
        )
        .limit(1);
      return row === undefined ? null : (row.flow as PushRequestFlow);
    },
  };
}
