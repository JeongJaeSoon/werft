import { randomUUID } from "node:crypto";
import {
  newSessionGitHubPolicy,
  type RepositoryAttachFailure,
} from "@werft-ai/contracts";
import type {
  RepositoryAttachmentRow,
  RepositoryAttachmentStore,
} from "@werft-ai/platform";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  agentGitHubSettingsRowOf,
  agentSettingsColumns,
} from "./github-settings.ts";
import type { Database } from "./queries.ts";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  attempts,
  receipts,
  sessionRepositoryAttachments,
  sessions,
} from "./schema.ts";

const sessionRelease = alias(agentReleases, "session_release");
const activeRelease = alias(agentReleases, "active_release");

const sessionTarget = (sessionId: string) => ({
  session_id: sessionId,
  turn_id: null,
  request_id: null,
});

const columns = {
  repositoryId: sessionRepositoryAttachments.repositoryId,
  attemptId: sessionRepositoryAttachments.attemptId,
  branch: sessionRepositoryAttachments.branch,
  status: sessionRepositoryAttachments.status,
  commit: sessionRepositoryAttachments.gitCommit,
  failure: sessionRepositoryAttachments.failure,
  receiptId: sessionRepositoryAttachments.receiptId,
};

function rowOf(row: {
  repositoryId: string;
  attemptId: string;
  branch: string;
  status: string;
  commit: string | null;
  failure: string | null;
  receiptId: string;
}): RepositoryAttachmentRow {
  return {
    ...row,
    status: row.status as RepositoryAttachmentRow["status"],
    failure: row.failure as RepositoryAttachFailure | null,
  };
}

/** session-repository-attachment.md decision 3: what `attach_repository` writes. */
export function createPostgresRepositoryAttachments(
  db: Database,
): RepositoryAttachmentStore {
  async function find(sessionId: string, repositoryId: string) {
    const [row] = await db
      .select(columns)
      .from(sessionRepositoryAttachments)
      .where(
        and(
          eq(sessionRepositoryAttachments.sessionId, sessionId),
          eq(sessionRepositoryAttachments.repositoryId, repositoryId),
        ),
      )
      .limit(1);
    return row === undefined ? null : rowOf(row);
  }

  return {
    find: (sessionId, repositoryId) =>
      find(sessionId.toLowerCase(), repositoryId),

    request(input) {
      return db.transaction(async (tx) => {
        // Serializes two calls for the session, so one row and one receipt
        // come of them.
        const [session] = await tx
          .select({ attached: sessions.attachedRepositoryIds })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .for("update");
        const [attempt] = await tx
          .select({ id: attempts.id })
          .from(attempts)
          .where(
            and(
              eq(attempts.id, input.attemptId),
              eq(attempts.sessionId, input.sessionId),
              isNull(attempts.endedAt),
            ),
          )
          .limit(1);
        if (session === undefined || attempt === undefined) {
          return { outcome: "attempt_ended" as const };
        }
        const [existing] = await tx
          .select(columns)
          .from(sessionRepositoryAttachments)
          .where(
            and(
              eq(sessionRepositoryAttachments.sessionId, input.sessionId),
              eq(sessionRepositoryAttachments.repositoryId, input.repositoryId),
            ),
          )
          .limit(1);
        if (existing !== undefined && existing.status !== "failed") {
          return { outcome: "unchanged" as const, row: rowOf(existing) };
        }
        if (
          existing === undefined &&
          (session.attached === null ||
            session.attached.includes(input.repositoryId))
        ) {
          return { outcome: "preattached" as const };
        }
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.ownerId,
          operation: "attach_repository",
          targetRef: sessionTarget(input.sessionId),
          status: "accepted",
          result: input.result,
          error: null,
          actor: input.actor,
        });
        const values = {
          attemptId: input.attemptId,
          branch: input.branch,
          status: "pending",
          gitCommit: null,
          failure: null,
          receiptId,
          requestedAt: new Date(),
          settledAt: null,
        };
        await tx
          .insert(sessionRepositoryAttachments)
          .values({
            sessionId: input.sessionId,
            repositoryId: input.repositoryId,
            ...values,
          })
          .onConflictDoUpdate({
            target: [
              sessionRepositoryAttachments.sessionId,
              sessionRepositoryAttachments.repositoryId,
            ],
            set: values,
          });
        // A null list is the release's whole list already
        // (session-repository-attachment.md decision 2): left null.
        if (
          session.attached !== null &&
          !session.attached.includes(input.repositoryId)
        ) {
          await tx
            .update(sessions)
            .set({
              attachedRepositoryIds: [...session.attached, input.repositoryId],
            })
            .where(eq(sessions.id, input.sessionId));
        }
        return {
          outcome: "requested" as const,
          row: {
            repositoryId: input.repositoryId,
            attemptId: input.attemptId,
            branch: input.branch,
            status: "pending" as const,
            commit: null,
            failure: null,
            receiptId,
          },
        };
      });
    },

    async recordRefusal(input) {
      const id = randomUUID();
      await db.insert(receipts).values({
        id,
        ownerId: input.ownerId,
        operation: "attach_repository",
        targetRef: sessionTarget(input.sessionId),
        status: "failed",
        result: input.result,
        error: input.error,
        actor: input.actor,
      });
      return id;
    },

    async activeRelease(rawSessionId) {
      const [row] = await db
        .select({
          id: activeRelease.id,
          github: sql<unknown>`${activeRelease.policyPins} -> 'github'`,
          ...agentSettingsColumns,
        })
        .from(sessions)
        .innerJoin(
          sessionRelease,
          eq(sessionRelease.id, sessions.agentReleaseId),
        )
        .innerJoin(agents, eq(agents.id, sessionRelease.agentId))
        .innerJoin(activeRelease, eq(activeRelease.id, agents.activeReleaseId))
        .leftJoin(
          agentGitHubSettings,
          eq(agentGitHubSettings.agentId, agents.id),
        )
        .where(eq(sessions.id, rawSessionId.toLowerCase()))
        .limit(1);
      if (row === undefined) return null;
      const { id } = row;
      // What a session started now would run on, so a repository the agent's
      // settings no longer list is not offered as "allowed in a newer release".
      const { settings } = newSessionGitHubPolicy(
        agentGitHubSettingsRowOf(row),
        row.github,
      );
      return { id, github: settings };
    },

    async list(rawSessionId) {
      const rows = await db
        .select(columns)
        .from(sessionRepositoryAttachments)
        .where(
          eq(
            sessionRepositoryAttachments.sessionId,
            rawSessionId.toLowerCase(),
          ),
        )
        .orderBy(asc(sessionRepositoryAttachments.requestedAt));
      return rows.map(rowOf);
    },

    async pending(rawSessionId) {
      const rows = await db
        .select(columns)
        .from(sessionRepositoryAttachments)
        .where(
          and(
            eq(
              sessionRepositoryAttachments.sessionId,
              rawSessionId.toLowerCase(),
            ),
            eq(sessionRepositoryAttachments.status, "pending"),
          ),
        )
        .orderBy(asc(sessionRepositoryAttachments.requestedAt));
      return rows.map(rowOf);
    },

    async settle(rawSessionId, results) {
      const sessionId = rawSessionId.toLowerCase();
      for (const result of results) {
        await db.transaction(async (tx) => {
          const now = new Date();
          const [row] = await tx
            .update(sessionRepositoryAttachments)
            .set(
              result.status === "attached"
                ? {
                    status: "attached",
                    gitCommit: result.commit,
                    settledAt: now,
                  }
                : { status: "failed", failure: result.failure, settledAt: now },
            )
            .where(
              and(
                eq(sessionRepositoryAttachments.sessionId, sessionId),
                eq(
                  sessionRepositoryAttachments.repositoryId,
                  result.repository_id,
                ),
                eq(sessionRepositoryAttachments.receiptId, result.receipt_id),
                eq(sessionRepositoryAttachments.status, "pending"),
              ),
            )
            .returning({ receiptId: sessionRepositoryAttachments.receiptId });
          if (row === undefined) return;
          await tx
            .update(receipts)
            .set(
              result.status === "attached"
                ? {
                    status: "succeeded",
                    result: sql`${receipts.result} || ${JSON.stringify({ commit: result.commit })}::jsonb`,
                    updatedAt: now,
                  }
                : {
                    status: "failed",
                    result: sql`${receipts.result} || ${JSON.stringify({ failure: result.failure })}::jsonb`,
                    error: {
                      code: "BACKEND_UNAVAILABLE",
                      message: `Fetching the repository failed: ${result.failure}`,
                    },
                    updatedAt: now,
                  },
            )
            .where(eq(receipts.id, row.receiptId));
          if (result.status === "failed") {
            // A failed attachment is not attached: the next claim does not
            // fetch it, and the route refuses it until it is asked again.
            await tx
              .update(sessions)
              .set({
                attachedRepositoryIds: sql`array_remove(${sessions.attachedRepositoryIds}, ${result.repository_id})`,
              })
              .where(eq(sessions.id, sessionId));
          }
        });
      }
    },
  };
}
