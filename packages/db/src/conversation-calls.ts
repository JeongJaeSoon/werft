import {
  type BudgetRoot,
  type ConversationCallStore,
  chooseBudgetAccount,
  reservationTokens,
} from "@werft-ai/platform";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import {
  lockBudgetCall,
  releaseBudgetIn,
  reserveBudgetIn,
  settleBudgetIn,
} from "./budget-accounts.ts";
import { DB_NOW, fromDbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  agents,
  budgetReservations,
  conversationCalls,
  memberTeams,
} from "./schema.ts";

// The scale of the cost column, so a replay compares what was stored.
const toStoredCost = (costUsd: number) => Math.round(costUsd * 1e6) / 1e6;

function requesterUserOf(root: BudgetRoot): string | null {
  if (root.kind === "user") return root.userId;
  if (root.kind === "key" && root.keyKind === "personal") {
    return root.createdByUserId;
  }
  return null;
}

/**
 * Locks, in the one order every writer of a conversation call takes them:
 * budget-accounts.ts's call lock first, then this call's row, then the
 * reservation row and the account row (the budget ledger's own order). The
 * issue holds the account row while it inserts the call's row, which no one
 * can wait on before it commits. The grant question takes the call's row
 * alone, never an account.
 */
export function createPostgresConversationCalls(
  db: Database,
): ConversationCallStore {
  return {
    issueAtomic(input) {
      return db.transaction(async (tx) => {
        await lockBudgetCall(tx, input.callId);
        // The agent's team, while neither is deleted or archived: as the
        // session calls choose it (exchange-budget.ts).
        const [agent] = await tx
          .select({
            teamId: sql<
              string | null
            >`CASE WHEN ${memberTeams.archivedAt} IS NULL THEN ${memberTeams.id} END`,
          })
          .from(agents)
          .leftJoin(memberTeams, eq(memberTeams.id, agents.managingTeamId))
          .where(
            and(
              eq(agents.id, input.agentId),
              eq(agents.workspaceId, input.workspaceId),
              isNull(agents.deletedAt),
            ),
          )
          .limit(1);
        if (!agent) return { outcome: "unknown_agent" };
        const choice = chooseBudgetAccount(input.root, agent.teamId);
        const reserved = await reserveBudgetIn(tx, {
          callId: input.callId,
          workspaceId: input.workspaceId,
          choice,
          reserve: input.reserve,
          unmetered: input.unmetered,
        });
        if (reserved.outcome === "refused") {
          return {
            outcome: "refused",
            rootKind: choice.rootKind,
            accountId: reserved.accountId,
          };
        }
        // A fresh id under its own lock: nothing else reserved it.
        if (reserved.outcome !== "reserved") {
          throw new Error(
            `conversation call ${input.callId}: its id was already reserved`,
          );
        }
        const [row] = await tx
          .insert(conversationCalls)
          .values({
            id: input.callId,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            tokenHash: input.tokenHash,
            rootKind: choice.rootKind,
            requesterUserId: requesterUserOf(input.root),
            connectionId: input.connectionId,
            path: input.path,
            model: input.model,
            maxTokens: input.maxTokens,
            maxRequestBytes: input.maxRequestBytes,
            expiresAt: fromDbNow(input.ttlMs),
          })
          .returning({ expiresAt: conversationCalls.expiresAt });
        if (!row) throw new Error("conversation call row missing after insert");
        return { outcome: "issued", expiresAt: row.expiresAt };
      });
    },

    authorizeAtomic(input) {
      return db.transaction(async (tx) => {
        const limits = {
          callId: conversationCalls.id,
          connectionId: conversationCalls.connectionId,
          path: conversationCalls.path,
          model: conversationCalls.model,
          maxTokens: conversationCalls.maxTokens,
          maxRequestBytes: conversationCalls.maxRequestBytes,
        };
        // The first grant binds the token. Its condition is judged again
        // on the row once a concurrent first grant commits, so of two
        // exchanges only one is bound.
        const [bound] = await tx
          .update(conversationCalls)
          .set({
            state: "in_flight",
            exchangeId: input.exchangeId,
            startedAt: DB_NOW,
          })
          .where(
            and(
              eq(conversationCalls.tokenHash, input.tokenHash),
              eq(conversationCalls.state, "reserved"),
              gt(conversationCalls.expiresAt, DB_NOW),
            ),
          )
          .returning(limits);
        if (bound) return { outcome: "ok", ...bound };
        // The proxy's regrant of the exchange already bound.
        const [again] = await tx
          .select(limits)
          .from(conversationCalls)
          .where(
            and(
              eq(conversationCalls.tokenHash, input.tokenHash),
              eq(conversationCalls.state, "in_flight"),
              eq(conversationCalls.exchangeId, input.exchangeId),
              gt(conversationCalls.expiresAt, DB_NOW),
            ),
          )
          .limit(1);
        return again
          ? { outcome: "ok", ...again }
          : { outcome: "invalid_token" };
      });
    },

    settleAtomic(input) {
      return db.transaction(async (tx) => {
        await lockBudgetCall(tx, input.callId);
        const [call] = await tx
          .select()
          .from(conversationCalls)
          .where(eq(conversationCalls.id, input.callId))
          .for("update");
        if (!call) return { outcome: "unknown_call" };
        if (call.exchangeId !== input.exchangeId)
          return { outcome: "conflict" };
        if (call.state === "settled") {
          return Bun.deepEquals(call.usage, input.usage)
            ? { outcome: "already_settled", costUsd: call.costUsd ?? 0 }
            : { outcome: "conflict" };
        }
        // Bound and not settled is in flight: a release takes only an
        // unbound row.
        const [reservation] = await tx
          .select({ unmetered: budgetReservations.unmetered })
          .from(budgetReservations)
          .where(eq(budgetReservations.callId, input.callId));
        const unmetered = reservation?.unmetered ?? false;
        const costUsd = unmetered
          ? 0
          : toStoredCost(input.priceFor({ unmetered }).costUsd);
        const tokens = reservationTokens(input.usage);
        const settled = await settleBudgetIn(tx, {
          callId: input.callId,
          actual: { costUsd, tokens },
        });
        if (settled !== "settled") {
          throw new Error(
            `conversation call ${input.callId}: its reservation was ${settled}`,
          );
        }
        await tx
          .update(conversationCalls)
          .set({
            state: "settled",
            usage: input.usage,
            costUsd,
            tokens,
            endedAt: DB_NOW,
          })
          .where(eq(conversationCalls.id, input.callId));
        return { outcome: "settled", costUsd };
      });
    },

    async releaseExpired({ limit, dryRun }) {
      const expired = await db
        .select({ id: conversationCalls.id })
        .from(conversationCalls)
        .where(
          and(
            eq(conversationCalls.state, "reserved"),
            lt(conversationCalls.expiresAt, DB_NOW),
          ),
        )
        .orderBy(conversationCalls.expiresAt)
        .limit(limit);
      if (dryRun) return { released: expired.length };
      let released = 0;
      for (const { id } of expired) {
        const done = await db.transaction(async (tx) => {
          await lockBudgetCall(tx, id);
          // Judged again under the row's lock: a grant that bound it since
          // keeps it.
          const [call] = await tx
            .update(conversationCalls)
            .set({ state: "released", endedAt: DB_NOW })
            .where(
              and(
                eq(conversationCalls.id, id),
                eq(conversationCalls.state, "reserved"),
                lt(conversationCalls.expiresAt, DB_NOW),
              ),
            )
            .returning({ id: conversationCalls.id });
          if (!call) return false;
          await releaseBudgetIn(tx, id);
          return true;
        });
        if (done) released++;
      }
      return { released };
    },
  };
}
