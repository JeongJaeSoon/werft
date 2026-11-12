import { randomUUID } from "node:crypto";
import {
  type GitHubPullRequestOutcomeMetadata,
  PULL_REQUEST_OUTCOME_TITLE_MAX_LENGTH,
  type PullRequest,
  type PullRequestReceiptResult,
  type PullRequestRefusal,
  type PullRequestStage,
  type PushRequestState,
} from "@werft-ai/contracts";
import {
  PULL_REQUEST_REFUSAL_ERRORS,
  type PullRequestReceipt,
  type PullRequestStore,
  type ScheduleOutcome,
} from "@werft-ai/platform";
import { and, asc, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import {
  agentReleases,
  pullRequests,
  pushIntents,
  pushRequests,
  receipts,
  sessionOutcomes,
  sessions,
} from "../schema.ts";
import { queueAchievementJudgment } from "../sessions/achievement-judgments.ts";

type Row = typeof pullRequests.$inferSelect;

function publicPullRequest(row: Row): PullRequest {
  if (
    row.pushRequestId === null ||
    row.sessionId === null ||
    row.repositoryId === null ||
    row.number === null ||
    row.head === null ||
    row.base === null ||
    row.receiptId === null ||
    row.createdAt === null
  ) {
    throw new Error("pull request row predates push requests");
  }
  return {
    push_request_id: row.pushRequestId,
    session_id: row.sessionId,
    repository_id: row.repositoryId,
    number: row.number,
    url: row.url,
    head: row.head,
    base: row.base,
    created_at: row.createdAt.toISOString(),
    receipt_id: row.receiptId,
  };
}

async function insertReceipt(
  tx: Database,
  // Null for the schedule of a push intent that has no push request yet.
  input: Omit<PullRequestReceipt, "pushRequestId"> & {
    pushRequestId: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  const { refusal } = input.result;
  await tx.insert(receipts).values({
    id,
    ownerId: input.ownerId,
    operation: input.operation,
    targetRef: {
      session_id: input.sessionId,
      turn_id: null,
      request_id: input.result.push_request_id,
    },
    status: refusal === null ? "succeeded" : "failed",
    result: input.result,
    error: refusal === null ? null : PULL_REQUEST_REFUSAL_ERRORS[refusal],
    actor: input.actor,
  });
  return id;
}

/** The session's release and its agent, which every outcome copies. */
export async function sessionRelease(
  tx: Database,
  sessionId: string,
): Promise<{ agentReleaseId: string | null; agentId: string | null }> {
  const [release] = await tx
    .select({
      agentReleaseId: sessions.agentReleaseId,
      agentId: agentReleases.agentId,
    })
    .from(sessions)
    .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return {
    agentReleaseId: release?.agentReleaseId ?? null,
    agentId: release?.agentId ?? null,
  };
}

function outcomeTitle(title: string | null): string | null {
  return title === null
    ? null
    : title.slice(0, PULL_REQUEST_OUTCOME_TITLE_MAX_LENGTH);
}

/**
 * The `github_pull_request` outcome of a recorded pull request, its agent
 * copied from the session's release. Kept if the session already has one
 * for the URL; a new one queues a judgment of the session.
 */
export async function insertPullRequestOutcome(
  tx: Database,
  input: {
    ownerId: string;
    sessionId: string;
    url: string;
    repositoryId: string;
    number: number;
    title: string | null;
    head: string;
    base: string;
    adopted: boolean | null;
    receiptId: string;
    createdAt: Date;
  },
): Promise<void> {
  const release = await sessionRelease(tx, input.sessionId);
  const inserted = await tx
    .insert(sessionOutcomes)
    .values({
      id: randomUUID(),
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      agentReleaseId: release.agentReleaseId,
      agentId: release.agentId,
      type: "github_pull_request",
      url: input.url,
      repositoryId: input.repositoryId,
      externalId: String(input.number),
      state: "open",
      stateChangedAt: input.createdAt,
      metadata: {
        title: outcomeTitle(input.title),
        head: input.head,
        base: input.base,
        adopted: input.adopted,
        merge_commit_sha: null,
        additions: null,
        deletions: null,
        changed_files: null,
        commits: null,
      } satisfies GitHubPullRequestOutcomeMetadata,
      receiptId: input.receiptId,
      createdAt: input.createdAt,
    })
    .onConflictDoNothing({
      target: [
        sessionOutcomes.sessionId,
        sessionOutcomes.type,
        sessionOutcomes.url,
      ],
    })
    .returning({ id: sessionOutcomes.id });
  if (inserted.length > 0) await queueAchievementJudgment(tx, input.sessionId);
}

// Every push request of a session shares its branch, and so its pull request.
async function lockSession(tx: Database, id: string): Promise<void> {
  await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, id))
    .for("update");
}

async function findSessionRowByUrl(
  tx: Database,
  sessionId: string,
  url: string,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(pullRequests)
    .where(
      and(eq(pullRequests.sessionId, sessionId), eq(pullRequests.url, url)),
    )
    .limit(1);
  return row;
}

export async function findPullRequest(
  tx: Database,
  ownerId: string,
  pushRequestId: string,
): Promise<PullRequest | null> {
  const [row] = await tx
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.pushRequestId, pushRequestId.toLowerCase()),
        eq(pullRequests.ownerId, ownerId),
      ),
    )
    .limit(1);
  return row ? publicPullRequest(row) : null;
}

type SavePullRequestInput = Parameters<PullRequestStore["savePullRequest"]>[0];

/**
 * The write behind `savePullRequest`, for a caller that holds the
 * transaction (the pull request drain settles the stage in the same one).
 */
export async function savePullRequestIn(
  tx: Database,
  input: SavePullRequestInput,
): Promise<{ pullRequest: PullRequest; created: boolean; receiptId: string }> {
  await lockSession(tx, input.sessionId);
  const same = await findSessionRowByUrl(tx, input.sessionId, input.url);
  const recorded =
    (await findPullRequest(tx, input.ownerId, input.pushRequestId)) ??
    (same?.pushRequestId != null ? publicPullRequest(same) : null);
  const shown = recorded ?? {
    repository_id: input.repositoryId,
    number: input.number,
    url: input.url,
    head: input.head,
    base: input.base,
  };
  const created = recorded === null && same === undefined && input.created;
  const receiptId = await insertReceipt(tx, {
    ...input,
    operation: "open_pull_request",
    result: {
      push_request_id: input.pushRequestId,
      verdict: "allow",
      refusal: null,
      repository_id: shown.repository_id,
      number: shown.number,
      url: shown.url,
      head: shown.head,
      base: shown.base,
      created,
      ...(input.template == null ? {} : { template: input.template }),
    } satisfies PullRequestReceiptResult,
  });
  if (recorded !== null) {
    return { pullRequest: recorded, created: false, receiptId };
  }
  const values = {
    sessionId: input.sessionId,
    url: input.url,
    pushRequestId: input.pushRequestId,
    ownerId: input.ownerId,
    repositoryId: input.repositoryId,
    number: input.number,
    head: input.head,
    base: input.base,
    receiptId,
  };
  // A row from before push requests is filled in, not duplicated.
  const [row] =
    same === undefined
      ? await tx.insert(pullRequests).values(values).returning()
      : await tx
          .update(pullRequests)
          .set({ ...values, createdAt: new Date() })
          .where(
            and(
              eq(pullRequests.sessionId, input.sessionId),
              eq(pullRequests.url, input.url),
            ),
          )
          .returning();
  if (!row) throw new Error("pull request insert returned no row");
  await insertPullRequestOutcome(tx, {
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    url: input.url,
    repositoryId: input.repositoryId,
    number: input.number,
    title: input.title,
    head: input.head,
    base: input.base,
    adopted: !input.created,
    receiptId,
    createdAt: row.createdAt ?? new Date(),
  });
  return { pullRequest: publicPullRequest(row), created, receiptId };
}

export function createPostgresPullRequests(db: Database): PullRequestStore {
  return {
    schedule({ ownerId, sessionId: rawSessionId, ref, content, actor }) {
      const sessionId = rawSessionId.toLowerCase();
      const refused = (
        refusal: PullRequestRefusal,
        extra: Partial<Extract<ScheduleOutcome, { kind: "refused" }>> = {},
      ): ScheduleOutcome => ({ kind: "refused", refusal, ...extra });
      return db.transaction(async (tx): Promise<ScheduleOutcome> => {
        // Lock order: session row, intent row, push request row.
        const [session] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
          .limit(1)
          .for("update");
        if (!session) return refused("not_found");
        const scheduled = async (
          repositoryId: string,
          pushRequestId: string | null,
          pushIntentId: string | null,
        ): Promise<ScheduleOutcome> => ({
          kind: "scheduled",
          pushRequestId,
          pushIntentId,
          receiptId: await insertReceipt(tx, {
            ownerId,
            sessionId,
            pushRequestId,
            actor,
            operation: "open_pull_request",
            result: {
              push_request_id: pushRequestId,
              verdict: "allow",
              refusal: null,
              repository_id: repositoryId,
              number: null,
              url: null,
              head: null,
              base: null,
              created: null,
            },
          }),
        });
        let requestId: string;
        let intentId: string | null = null;
        if (ref.pushIntentId !== undefined) {
          const [intent] = await tx
            .select()
            .from(pushIntents)
            .where(
              and(
                eq(pushIntents.id, ref.pushIntentId.toLowerCase()),
                eq(pushIntents.sessionId, sessionId),
                eq(pushIntents.ownerId, ownerId),
              ),
            )
            .limit(1)
            .for("update");
          if (!intent) return refused("not_found");
          if (intent.pushRequestId === null) {
            if (intent.status !== "deferred" && intent.status !== "pinned") {
              return refused("intent_ended", {
                details: { intent_refusal: intent.refusalCode },
              });
            }
            // The first content stays.
            if (intent.pullRequest === null) {
              await tx
                .update(pushIntents)
                .set({ pullRequest: content, updatedAt: sql`now()` })
                .where(eq(pushIntents.id, intent.id));
            }
            return await scheduled(intent.repositoryId, null, intent.id);
          }
          requestId = intent.pushRequestId;
          intentId = intent.id;
        } else {
          requestId = ref.pushRequestId.toLowerCase();
        }
        const [request] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.id, requestId),
              eq(pushRequests.sessionId, sessionId),
              eq(pushRequests.ownerId, ownerId),
            ),
          )
          .limit(1)
          .for("update");
        if (!request) return refused("not_found");
        const stage = request.prState;
        // A recorded pull request or a finished stage is the open path's to
        // answer; a scheduled call never moves either back.
        // A pushed request made on the legacy flow, with no stage, still
        // opens at once as it always did.
        if (
          (await findPullRequest(tx, ownerId, request.id)) !== null ||
          (stage !== null && stage !== "due" && stage !== "opening") ||
          (request.state === "pushed" &&
            request.flow === "legacy" &&
            stage === null)
        ) {
          return { kind: "open_now", pushRequestId: request.id };
        }
        // Only the actions flow schedules. A legacy request that is not
        // pushed yet is refused as it was before scheduling existed (flag
        // off is every legacy request), even when an earlier build stored
        // content on it: the follow-up turn opens its pull request, and a
        // due stage would have the drain open it as well.
        if (
          request.state === "rejected" ||
          request.state === "failed" ||
          request.flow === "legacy"
        ) {
          return refused("not_pushed", {
            pushRequestState: request.state as PushRequestState,
            details: { push_request_id: request.id },
          });
        }
        const [later] = await tx
          .select({ id: pushRequests.id })
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.sessionId, sessionId),
              eq(pushRequests.repositoryId, request.repositoryId),
              eq(pushRequests.targetBranch, request.targetBranch),
              // Compared inside the database: a JavaScript Date keeps only
              // milliseconds, and two requests may share one.
              sql`${pushRequests.createdAt} > (SELECT created_at FROM push_requests WHERE id = ${request.id})`,
              ne(pushRequests.id, request.id),
            ),
          )
          .orderBy(asc(pushRequests.createdAt))
          .limit(1);
        if (later) {
          return refused("superseded", {
            details: { push_request_id: later.id },
          });
        }
        const keep = request.pullRequestIntent !== null;
        const due = request.state === "pushed" && stage === null;
        if (!keep || due) {
          await tx
            .update(pushRequests)
            .set({
              pullRequestIntent: request.pullRequestIntent ?? content,
              ...(due ? { prState: "due", prNextAttemptAt: null } : {}),
            })
            .where(eq(pushRequests.id, request.id));
        }
        return await scheduled(request.repositoryId, request.id, intentId);
      });
    },

    async findSource(ownerId, sessionId, pushRequestId) {
      const [row] = await db
        .select()
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.id, pushRequestId.toLowerCase()),
            eq(pushRequests.sessionId, sessionId.toLowerCase()),
            eq(pushRequests.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        sessionId: row.sessionId,
        repositoryId: row.repositoryId,
        repositoryBinding: row.repositoryBinding,
        state: row.state as PushRequestState,
        targetBranch: row.targetBranch,
        gitCommit: row.gitCommit,
        prState: row.prState as PullRequestStage | null,
        prError: row.prError,
        prErrorDetails:
          (row.prErrorDetails as Record<string, unknown> | null) ?? null,
      };
    },

    async failHeadMoved({ ownerId, pushRequestId, details }) {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: pushRequests.id })
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.id, pushRequestId),
              eq(pushRequests.ownerId, ownerId),
            ),
          )
          .limit(1)
          .for("update");
        if (!row || (await findPullRequest(tx, ownerId, row.id)) !== null) {
          return;
        }
        await tx
          .update(pushRequests)
          .set({
            prState: "failed",
            prError: "head_moved",
            prErrorDetails: details,
            prNextAttemptAt: null,
            prClaimToken: null,
            prLeaseExpiresAt: null,
          })
          .where(eq(pushRequests.id, row.id));
      });
    },

    findPullRequest(ownerId, pushRequestId) {
      return findPullRequest(db, ownerId, pushRequestId);
    },

    async findBranchPullRequest(ownerId, sessionId, repositoryId, head) {
      const [row] = await db
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.ownerId, ownerId),
            eq(pullRequests.sessionId, sessionId.toLowerCase()),
            eq(pullRequests.repositoryId, repositoryId),
            eq(pullRequests.head, head),
            isNotNull(pullRequests.pushRequestId),
          ),
        )
        .orderBy(desc(pullRequests.createdAt))
        .limit(1);
      return row ? publicPullRequest(row) : null;
    },

    recordReceipt(input) {
      return insertReceipt(db, input);
    },

    recordStateChange({ url, ...input }) {
      return db.transaction(async (tx) => {
        const receiptId = await insertReceipt(tx, input);
        // closed_at too: the refresher skips one closed over 30 days ago. The
        // lease too: a read that began before this change must not finish.
        await tx
          .update(sessionOutcomes)
          .set({
            stateCheckedAt: null,
            closedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(
            and(
              eq(sessionOutcomes.sessionId, input.sessionId),
              eq(sessionOutcomes.type, "github_pull_request"),
              eq(sessionOutcomes.url, url),
              ne(sessionOutcomes.state, "merged"),
            ),
          );
        return receiptId;
      });
    },

    savePullRequest(input) {
      return db.transaction((tx) => savePullRequestIn(tx, input));
    },
  };
}
