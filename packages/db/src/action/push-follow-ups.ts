import type {
  PushRequestFlow,
  PushRoot,
  RequesterAuth,
} from "@werft-ai/contracts";
import type { PushFollowUpStore } from "@werft-ai/platform";
import { and, eq, max, or, sql } from "drizzle-orm";
import { newTurnSources } from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import {
  agentReleases,
  pullRequests,
  pushFollowUps,
  pushIntents,
  pushRequests,
  sessions,
  turns,
} from "../schema.ts";
import { enqueueWithin } from "../sessions/index.ts";

export type PushFollowUpHold = "now" | "held" | "pull_request" | "queued";

/**
 * Whether the session already has this push request's follow-up turn. The
 * turn is its own mark: read under the session lock by every path that
 * queues one, so a decision that comes in twice queues one turn.
 */
export async function pushFollowUpQueued(
  tx: Database,
  sessionId: string,
  pushRequestId: string,
): Promise<boolean> {
  const [found] = await tx
    .select({ id: turns.id })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, sessionId),
        sql`${turns.requesterAuth}->>'method' = 'push_decision'`,
        sql`${turns.requesterAuth}->>'push_request_id' = ${pushRequestId}`,
      ),
    )
    .limit(1);
  return found !== undefined;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The requester a push follow-up turn records: the agent, no person. The
 * root is whose request it came from (the turn that asked for the push, or
 * that turn's own root), kept so later work traces back to that person.
 */
export async function pushFollowUpRequester(
  tx: Database,
  input: {
    agentReleaseId: string | null;
    pushRequestId: string;
    decision: "approve" | "reject";
  },
): Promise<{
  requesterKind: string | null;
  requesterId: string | null;
  requesterAuth: RequesterAuth;
}> {
  const [release] =
    input.agentReleaseId === null
      ? []
      : await tx
          .select({ agentId: agentReleases.agentId })
          .from(agentReleases)
          .where(eq(agentReleases.id, input.agentReleaseId))
          .limit(1);
  const [asked] = await tx
    .select({
      sequence: turns.sequence,
      requesterKind: turns.requesterKind,
      requesterId: turns.requesterId,
      requesterAuth: turns.requesterAuth,
    })
    .from(pushIntents)
    .innerJoin(turns, eq(turns.id, pushIntents.turnId))
    .where(eq(pushIntents.pushRequestId, input.pushRequestId))
    .limit(1);
  let root: PushRoot | undefined;
  if (asked !== undefined) {
    const auth = asObject(asked.requesterAuth);
    const inherited =
      auth?.method === "push_decision" ? asObject(auth.root) : null;
    if (inherited !== null) {
      root = inherited as PushRoot;
    } else {
      const { carried_from: _carried, via, ...credential } = auth ?? {};
      root = {
        requester_kind: asked.requesterKind,
        requester_id: asked.requesterId,
        requester_auth: auth === null ? null : credential,
        via: Array.isArray(via) ? via : [],
      };
    }
  }
  const agentId = release?.agentId ?? null;
  return {
    requesterKind: agentId === null ? null : "agent",
    requesterId: agentId,
    requesterAuth: {
      method: "push_decision",
      push_request_id: input.pushRequestId,
      decision: input.decision,
      ...(asked === undefined
        ? {}
        : {
            root,
            carried_from: {
              turn: String(asked.sequence),
              reason: "push_follow_up",
            },
          }),
    },
  };
}

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

// The three wordings the Slack decision wrote (two versions of the approved
// one), matched whole and nothing looser: a person's own message that merely
// starts like one of them, or differs by a sentence, is not ours to rewrite.
const LEGACY_SUBJECT = "push request \\S+ \\(repository [^,]+, branch [^)]+\\)";
const LEGACY_APPROVED_TAILS = [
  "wait a few seconds and call it again\\.",
  "with push_request_state approved or pushing, wait a few seconds and call it again\\. In any other state, calling it again will not change the answer: say what it answered instead\\.",
];
const LEGACY_APPROVED = new RegExp(
  `^Platform note: a person approved (${LEGACY_SUBJECT}) in Slack\\. The push runs in the background: call open_pull_request now, and if it answers not_pushed(?:, ${LEGACY_APPROVED_TAILS[0]}| ${LEGACY_APPROVED_TAILS[1]}) Then finish what you were asked to do\\.$`,
);
const LEGACY_REJECTED = new RegExp(
  `^Platform note: a person rejected (${LEGACY_SUBJECT}) in Slack, so nothing was pushed\\. Do not ask to push it again unless you are asked to\\. Say in one short reply that the push was rejected\\.$`,
);

/**
 * Rows and queued turns written before the wording became facts carry
 * directives; whichever path they come in by, the text is rewritten when it
 * is queued or delivered.
 */
export function followUpFact(message: string): string {
  const approved = LEGACY_APPROVED.exec(message);
  if (approved?.[1] !== undefined) {
    return `A person approved ${approved[1]}. The push runs in the background.`;
  }
  const rejected = LEGACY_REJECTED.exec(message);
  if (rejected?.[1] !== undefined) {
    return `A person rejected ${rejected[1]}. Nothing was pushed.`;
  }
  return message;
}

/**
 * Decides, under the session lock finalize also takes, what becomes of an
 * approved push's follow-up turn: `pull_request` when the push's branch
 * already has one recorded (nothing to ask for), `held` when a turn is
 * running (it may open the pull request itself; the next turn end decides),
 * `queued` when the session already has this push's follow-up turn, `now`
 * when the caller should queue it at once.
 */
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
    if (await pushFollowUpQueued(tx, input.sessionId, input.pushRequestId)) {
      return "queued";
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
    if (
      (await pullRequestRecorded(tx, session.id, hold.pushRequestId)) ||
      (await pushFollowUpQueued(tx, session.id, hold.pushRequestId))
    ) {
      continue;
    }
    const message = followUpFact(hold.message);
    const [last] = await tx
      .select({ sequence: max(turns.sequence) })
      .from(turns)
      .where(eq(turns.sessionId, session.id));
    // Only an approval is held, so this is an approval's follow-up.
    const requester = await pushFollowUpRequester(tx, {
      agentReleaseId: session.agentReleaseId,
      pushRequestId: hold.pushRequestId,
      decision: "approve",
    });
    const [turn] = await tx
      .insert(turns)
      .values({
        sessionId: session.id,
        sequence: (last?.sequence ?? 0) + 1,
        message,
        status: "queued",
        createdAt: sql`clock_timestamp()`,
        // The agent's turn: no person sent it.
        actorId: null,
        ...requester,
        sources: await newTurnSources(tx, {
          sessionId: session.id,
          slackMessage: null,
        }),
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
