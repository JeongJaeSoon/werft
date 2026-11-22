import { randomUUID } from "node:crypto";
import {
  newSessionGitHubPolicy,
  type RepositoryAttachFailure,
  repositoryRestoreFailedEventDataSchema,
} from "@werft-ai/contracts";
import type {
  RepositoryAttachmentRow,
  RepositoryAttachmentStore,
  RepositoryPinStore,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  agentGitHubSettingsRowOf,
  agentSettingsColumns,
} from "../github/index.ts";
import type { Database } from "../queries.ts";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  attempts,
  receipts,
  sessionRepositoryAttachments,
  sessionRepositoryPins,
  sessions,
} from "../schema.ts";
import { acquireFence } from "./fence.ts";
import { recordEvent } from "./session-events.ts";

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

/** What `attach_repository` writes. */
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
        // A repository a worker could not fetch again at its pin is attached
        // in name only: asking again fetches the branch tip and pins anew.
        const [lost] = await tx
          .delete(sessionRepositoryPins)
          .where(
            and(
              eq(sessionRepositoryPins.sessionId, input.sessionId),
              eq(sessionRepositoryPins.repositoryId, input.repositoryId),
              isNotNull(sessionRepositoryPins.restoreFailedAt),
            ),
          )
          .returning({ repositoryId: sessionRepositoryPins.repositoryId });
        // A fetch still pending is left to settle its own receipt; without
        // the pin it takes the tip.
        if (
          existing !== undefined &&
          (existing.status === "pending" ||
            (lost === undefined && existing.status !== "failed"))
        ) {
          return { outcome: "unchanged" as const, row: rowOf(existing) };
        }
        if (
          lost === undefined &&
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
        // A null list is the release's whole list already: left null.
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

    async settle(fence, results) {
      const sessionId = fence.sessionId.toLowerCase();
      for (const result of results) {
        const settled = await db.transaction(async (tx) => {
          // Taken first, so this and the pin route lock the session row
          // before the pin's key, in one order.
          const fenced = await acquireFence(tx, fence);
          if (fenced.outcome !== "ok") return fenced;
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
          if (row === undefined) return { outcome: "ok" as const };
          if (result.status === "attached") {
            // A pin in force stays; one a worker could not fetch again gives
            // way to what this attach fetched, which the agent asked for.
            await tx
              .insert(sessionRepositoryPins)
              .values({
                sessionId,
                repositoryId: result.repository_id,
                gitCommit: result.commit,
              })
              .onConflictDoUpdate({
                target: [
                  sessionRepositoryPins.sessionId,
                  sessionRepositoryPins.repositoryId,
                ],
                set: {
                  gitCommit: result.commit,
                  pinnedAt: now,
                  restoreFailedAt: null,
                },
                setWhere: isNotNull(sessionRepositoryPins.restoreFailedAt),
              });
          }
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
          return { outcome: "ok" as const };
        });
        if (settled.outcome !== "ok") return settled;
      }
      return { outcome: "ok" };
    },
  };
}

export function createPostgresRepositoryPins(db: Database): RepositoryPinStore {
  const read = async (
    tx: Database,
    sessionId: string,
    failed: boolean,
    repositoryIds?: readonly string[],
  ): Promise<Map<string, string>> => {
    const rows = await tx
      .select({
        repositoryId: sessionRepositoryPins.repositoryId,
        commit: sessionRepositoryPins.gitCommit,
      })
      .from(sessionRepositoryPins)
      .where(
        and(
          eq(sessionRepositoryPins.sessionId, sessionId),
          failed
            ? isNotNull(sessionRepositoryPins.restoreFailedAt)
            : isNull(sessionRepositoryPins.restoreFailedAt),
          repositoryIds === undefined
            ? undefined
            : inArray(sessionRepositoryPins.repositoryId, [...repositoryIds]),
        ),
      );
    return new Map(rows.map((row) => [row.repositoryId, row.commit]));
  };
  return {
    list: (rawSessionId) => read(db, rawSessionId.toLowerCase(), false),
    restoreFailures: (rawSessionId) =>
      read(db, rawSessionId.toLowerCase(), true),
    pin: (fence, pins, restoreFailed = []) =>
      db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return { outcome: fenced.outcome };
        const sessionId = fence.sessionId.toLowerCase();
        const now = new Date();
        for (const failure of restoreFailed) {
          // Only the pin the worker tried: a report naming another commit,
          // or one already marked, changes nothing and records nothing.
          const [marked] = await tx
            .update(sessionRepositoryPins)
            .set({ restoreFailedAt: now })
            .where(
              and(
                eq(sessionRepositoryPins.sessionId, sessionId),
                eq(sessionRepositoryPins.repositoryId, failure.repositoryId),
                eq(sessionRepositoryPins.gitCommit, failure.commit),
                isNull(sessionRepositoryPins.restoreFailedAt),
              ),
            )
            .returning({ repositoryId: sessionRepositoryPins.repositoryId });
          if (marked === undefined) continue;
          await recordEvent(tx, {
            sessionId,
            type: "system",
            payload: repositoryRestoreFailedEventDataSchema.parse({
              type: "system",
              subtype: "repository_restore_failed",
              repository_id: failure.repositoryId,
              commit: failure.commit,
            }),
            turnRowId: null,
            attemptId: fence.attemptId,
            now,
          });
        }
        if (pins.length === 0) return { outcome: "ok", pins: new Map() };
        await tx
          .insert(sessionRepositoryPins)
          .values(
            pins.map((pin) => ({
              sessionId,
              repositoryId: pin.repositoryId,
              gitCommit: pin.commit,
            })),
          )
          .onConflictDoNothing();
        return {
          outcome: "ok",
          pins: await read(
            tx,
            sessionId,
            false,
            pins.map((pin) => pin.repositoryId),
          ),
        };
      }),
  };
}
