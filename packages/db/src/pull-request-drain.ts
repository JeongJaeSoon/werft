import { randomUUID } from "node:crypto";
import { openPullRequestRequestSchema } from "@werft-ai/contracts";
import {
  type ActionNotice,
  PULL_REQUEST_MAX_ATTEMPTS,
  type PullRequestDrainOutcome,
  type PullRequestDrainStore,
  type PullRequestJob,
  type PullRequestSettled,
} from "@werft-ai/platform";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { enqueueActionNotice } from "./action-notices.ts";
import { findPullRequest, savePullRequestIn } from "./pull-requests.ts";
import type { Database } from "./queries.ts";
import { pushRequests, sessions, slackOutbox } from "./schema.ts";

// Parenthesized as a whole: it sits inside `and(...)`, where a bare top-level
// OR binds looser than its neighbours and lets its other branch ignore them.
const due = sql`((${pushRequests.prState} = 'due' AND (${pushRequests.prNextAttemptAt} IS NULL OR ${pushRequests.prNextAttemptAt} <= now())) OR (${pushRequests.prState} = 'opening' AND (${pushRequests.prLeaseExpiresAt} IS NULL OR ${pushRequests.prLeaseExpiresAt} < now())))`;

const cleared = {
  prClaimToken: null,
  prLeaseExpiresAt: null,
} as const;

/** A claim that used the last attempt and died: claiming again would loop. */
const exhausted = sql`${pushRequests.prState} = 'opening' AND ${pushRequests.prAttempts} >= ${PULL_REQUEST_MAX_ATTEMPTS} AND (${pushRequests.prLeaseExpiresAt} IS NULL OR ${pushRequests.prLeaseExpiresAt} < now())`;
const notExhausted = sql`NOT (${exhausted})`;

/**
 * Ends stages whose last attempt died with its lease: uncertain (the forge
 * may have taken the create, and nothing here asks it), and the thread
 * is told. Each row takes the session lock before the request lock, the order
 * `settle` takes, because the notice insert needs the session row too.
 */
async function endExhausted(db: Database): Promise<void> {
  const stale = await db
    .select({ id: pushRequests.id, sessionId: pushRequests.sessionId })
    .from(pushRequests)
    .where(
      and(
        eq(pushRequests.state, "pushed"),
        eq(pushRequests.flow, "actions"),
        exhausted,
      ),
    )
    .limit(20);
  for (const { id, sessionId } of stale) {
    await db.transaction(async (tx) => {
      await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for("update");
      const [row] = await tx
        .select()
        .from(pushRequests)
        .where(and(eq(pushRequests.id, id), exhausted))
        .limit(1)
        .for("update");
      if (!row) return;
      await tx
        .update(pushRequests)
        .set({
          prState: "uncertain",
          prError: "lease_expired",
          prNextAttemptAt: null,
          ...cleared,
        })
        .where(eq(pushRequests.id, id));
      if (row.flow !== "actions") return;
      await enqueueActionNotice(tx, {
        sessionId,
        pushRequestId: id,
        notice: {
          result: "pr_uncertain",
          repository: row.repositoryId,
          branch: row.targetBranch,
          commit: row.gitCommit,
          reason: "lease_expired",
        },
      });
    });
  }
}

/**
 * The pull request drain's claim and settle. A claim is a token written with
 * the lease; every settle is conditioned on the token while the row is
 * `opening`, so a claim whose lease lapsed cannot write over its successor.
 */
export function createPostgresPullRequestDrain(
  db: Database,
): PullRequestDrainStore {
  return {
    async claimNextDue(leaseMs): Promise<PullRequestJob | null> {
      await endExhausted(db);
      return await db.transaction(async (tx) => {
        // A row whose intent no longer parses leaves the candidates, so this
        // ends. Failing one writes a notice that references the session, so
        // that path needs the session row too; it never waits for it (a
        // schedule holds the session while it waits for the request, and a
        // wait here would close the circle): a session someone else holds
        // leaves the row alone for this claim, and the loop moves on.
        const passed: string[] = [];
        for (;;) {
          const [candidate] = await tx
            .select()
            .from(pushRequests)
            .where(
              and(
                eq(pushRequests.state, "pushed"),
                // Only the actions flow has a drain; a legacy row left due
                // or opening by an earlier build is the follow-up turn's.
                eq(pushRequests.flow, "actions"),
                due,
                notExhausted,
                passed.length === 0
                  ? undefined
                  : notInArray(pushRequests.id, passed),
              ),
            )
            .orderBy(pushRequests.createdAt)
            .limit(1)
            .for("update", { skipLocked: true });
          if (!candidate) return null;
          const parsed =
            candidate.pullRequestIntent === null
              ? { success: true as const, data: null }
              : openPullRequestRequestSchema.safeParse(
                  candidate.pullRequestIntent,
                );
          if (!parsed.success) {
            const [session] = await tx
              .select({ id: sessions.id })
              .from(sessions)
              .where(eq(sessions.id, candidate.sessionId))
              .for("update", { skipLocked: true });
            if (!session) {
              passed.push(candidate.id);
              continue;
            }
            await tx
              .update(pushRequests)
              .set({
                prState: "failed",
                prError: "intent_invalid",
                prNextAttemptAt: null,
                ...cleared,
              })
              .where(eq(pushRequests.id, candidate.id));
            // The thread learns of it in the same transaction; only an
            // `actions` request is told, as for every other result.
            if (candidate.flow === "actions") {
              await enqueueActionNotice(tx, {
                sessionId: candidate.sessionId,
                pushRequestId: candidate.id,
                notice: {
                  result: "pr_failed",
                  repository: candidate.repositoryId,
                  branch: candidate.targetBranch,
                  commit: candidate.gitCommit,
                  reason: "intent_invalid",
                },
              });
            }
            continue;
          }
          const claimToken = randomUUID();
          const [row] = await tx
            .update(pushRequests)
            .set({
              prState: "opening",
              prClaimToken: claimToken,
              prAttempts: sql`${pushRequests.prAttempts} + 1`,
              prLeaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
            })
            .where(eq(pushRequests.id, candidate.id))
            .returning();
          if (!row?.prLeaseExpiresAt) {
            throw new Error("push request update returned no row");
          }
          return {
            id: row.id,
            ownerId: row.ownerId,
            sessionId: row.sessionId,
            repositoryId: row.repositoryId,
            repositoryBinding: row.repositoryBinding,
            targetBranch: row.targetBranch,
            gitCommit: row.gitCommit,
            intent: parsed.data,
            claimToken,
            attempt: row.prAttempts,
            leaseExpiresAt: row.prLeaseExpiresAt,
          };
        }
      });
    },

    settle(job, outcome): Promise<PullRequestSettled> {
      return db.transaction(async (tx) => {
        // The session first, then the request: the order every writer of a
        // session's push requests takes.
        await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, job.sessionId))
          .for("update");
        const [row] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.id, job.id),
              eq(pushRequests.prState, "opening"),
              eq(pushRequests.prClaimToken, job.claimToken),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) return { result: "fenced" };
        return await write(tx, job, outcome, row.flow);
      });
    },
  };
}

async function write(
  tx: Database,
  job: PullRequestJob,
  outcome: PullRequestDrainOutcome,
  flow: string,
): Promise<PullRequestSettled> {
  const fence = and(
    eq(pushRequests.id, job.id),
    eq(pushRequests.prClaimToken, job.claimToken),
  );
  // The notice goes in this transaction, after the state it reports; a
  // request made before the action flows (`legacy`) tells the thread nothing.
  const tell = async (
    result: ActionNotice["result"],
    more: Partial<ActionNotice> = {},
  ) => {
    if (flow !== "actions") return;
    await enqueueActionNotice(tx, {
      sessionId: job.sessionId,
      pushRequestId: job.id,
      notice: {
        result,
        repository: job.repositoryId,
        branch: job.targetBranch,
        commit: job.gitCommit,
        ...more,
      },
    });
  };
  if (outcome.kind === "retry") {
    await tx
      .update(pushRequests)
      .set({
        prState: "due",
        prError: outcome.error,
        prNextAttemptAt: sql`now() + make_interval(secs => ${outcome.delayMs / 1000})`,
        ...cleared,
      })
      .where(fence);
    return { result: "settled" };
  }
  if (outcome.kind === "stop") {
    await tx
      .update(pushRequests)
      .set({
        prState: outcome.stage,
        prError: outcome.error,
        prErrorDetails: outcome.details ?? null,
        prNextAttemptAt: null,
        ...cleared,
      })
      .where(fence);
    const found = outcome.details?.numbers;
    const number =
      Array.isArray(found) && typeof found[0] === "number"
        ? found[0]
        : undefined;
    await tell(
      outcome.stage === "closed_unrecorded"
        ? "pr_closed"
        : outcome.stage === "uncertain"
          ? "pr_uncertain"
          : "pr_failed",
      {
        reason: outcome.error,
        ...(number === undefined ? {} : { number }),
      },
    );
    return { result: "settled" };
  }
  const opened = outcome.pullRequest;
  const recorded = await findPullRequest(tx, job.ownerId, job.id);
  if (recorded !== null && recorded.number !== opened.number) {
    await tx
      .update(pushRequests)
      .set({
        prState: "uncertain",
        prError: "duplicate_pull_request",
        prErrorDetails: {
          recorded: { number: recorded.number, url: recorded.url },
          forge: { number: opened.number, url: opened.url },
        },
        prNextAttemptAt: null,
        ...cleared,
      })
      .where(fence);
    await tell("pr_uncertain", { reason: "duplicate_pull_request" });
    return {
      result: "duplicate",
      recorded: { number: recorded.number, url: recorded.url },
    };
  }
  // The thread already heard of this pull request (an earlier push's notice
  // links it): this push updated it. A thread that was never told, say its
  // installation was revoked then, hears it opened.
  const [told] = await tx
    .select({ id: slackOutbox.id })
    .from(slackOutbox)
    .where(
      and(
        eq(slackOutbox.sessionId, job.sessionId),
        eq(slackOutbox.kind, "action_notice"),
        sql`${slackOutbox.body} ->> 'link_url' = ${opened.url}`,
      ),
    )
    .limit(1);
  await savePullRequestIn(tx, {
    ownerId: job.ownerId,
    sessionId: job.sessionId,
    pushRequestId: job.id,
    actor: null,
    repositoryId: job.repositoryId,
    number: opened.number,
    url: opened.url,
    title: opened.title,
    head: opened.head,
    base: opened.base,
    created: opened.created,
    template: opened.template ?? null,
  });
  await tx
    .update(pushRequests)
    .set({
      prState: "opened",
      prError: null,
      prErrorDetails: null,
      prNextAttemptAt: null,
      prVerifiedNumber: opened.number,
      prVerifiedHeadSha: opened.headSha,
      ...cleared,
    })
    .where(fence);
  await tell(told === undefined ? "opened" : "pr_updated", {
    number: opened.number,
    url: opened.url,
  });
  return { result: "settled" };
}
