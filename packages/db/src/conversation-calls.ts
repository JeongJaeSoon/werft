import { randomBytes } from "node:crypto";
import {
  type BudgetAccountId,
  CONVERSATION_TURN_MODEL_CALL_LIMIT,
  CONVERSATION_TURN_TOOL_CALL_LIMIT,
  type ConversationCallClass,
  type ConversationId,
  type ConversationKind,
  type ConversationTopicId,
  type ConversationTurnCallRefusal,
  type ConversationTurnId,
} from "@werft-ai/contracts";
import {
  type BudgetChoice,
  type BudgetRoot,
  CHANNEL_LIMITED_CLASS,
  CONVERSATION_CALL_LIMIT_VALUES,
  CONVERSATION_CALL_LIMITS,
  type ConversationCallIssue,
  type ConversationCallIssueInput,
  type ConversationCallPricedBy,
  type ConversationCallStore,
  type ConversationTurnCallAuthorization,
  type ConversationTurnPermitInput,
  type ConversationTurnPermitIssue,
  type ConversationUnsolicitedTurnIssue,
  chooseBudgetAccount,
  placeSource,
  reservationTokens,
  storedSourceSet,
} from "@werft-ai/platform";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  lockBudgetCall,
  markBudgetUnknownIn,
  releaseBudgetIn,
  reserveBudgetIn,
  settleBudgetIn,
} from "./budget-accounts.ts";
import { lockedDeletedSource } from "./conversations/deleted-sources.ts";
import {
  CLOSED_WORK_ADMISSION_STATES,
  threadWorkAdmission,
} from "./conversations/session-work.ts";
import { DB_NOW, dbNow, fromDbNow } from "./db-clock.ts";
import { PROVIDER_EXCHANGE_LEASE_MS } from "./provider-exchanges.ts";
import type { Database } from "./queries.ts";
import {
  agents,
  budgetAdjustments,
  budgetReservations,
  conversationCalls,
  conversationEngagements,
  conversations,
  conversationTopics,
  conversationTurnPermits,
  conversationTurns,
  memberTeams,
} from "./schema.ts";
import { rowsOf } from "./statement-rows.ts";
import { conversationReplyDedupeKey } from "./surface/conversation-replies.ts";

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
 * The locks of the keys a call is counted under, sorted. Anything that
 * moves a call into or out of what a limit counts by a test of the clock
 * (a first grant before its token expires) takes them too, so an issue
 * never reads that call on the other side of the change.
 */
async function lockConversationCallLimitsIn(
  tx: Database,
  call: {
    workspaceId: string;
    agentId: string;
    requesterUserId: string | null;
  },
): Promise<void> {
  const keys = [`agent:${call.agentId}`];
  if (call.requesterUserId !== null) {
    keys.push(`requester:${call.workspaceId}:${call.requesterUserId}`);
  }
  for (const key of keys.sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('conversation_call_limit'), hashtext(${key}))`,
    );
  }
}

/** What one call is counted under while in progress. */
export type ConversationCallScope = {
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  conversationKind: ConversationKind;
  topicId: ConversationTopicId | null;
  callClass: ConversationCallClass;
  requesterUserId: string | null;
  /** A turn counts once under each limit, however many of its calls are open. */
  conversationTurnId?: ConversationTurnId;
};

/** Thrown to take back what a turn call held when its permit ran out meanwhile. */
class TurnPermitLapsed extends Error {}

type LimitReached = Extract<
  ConversationCallIssue,
  { outcome: "concurrency_limited" }
>;

/**
 * Counts the calls in progress under each of the scope's keys, holding each
 * key's lock to the end of `tx`: the first key at its limit, or null when the
 * call fits. A call written in `tx` after a null is counted by the next one.
 * Take it after the call's own locks and before any budget row; the keys are
 * taken sorted, so two callers sharing a person never wait on each other.
 */
export async function holdConversationCallLimitsIn(
  tx: Database,
  scope: ConversationCallScope,
): Promise<LimitReached | null> {
  await lockConversationCallLimitsIn(tx, scope);
  const c = conversationCalls;
  const ofAgent = eq(c.agentId, scope.agentId);
  const scoped = {
    agent: ofAgent,
    channel:
      scope.conversationKind === "channel" &&
      scope.callClass === CHANNEL_LIMITED_CLASS
        ? and(
            ofAgent,
            eq(c.conversationId, scope.conversationId),
            eq(c.callClass, CHANNEL_LIMITED_CLASS),
          )
        : null,
    topic:
      scope.topicId === null
        ? null
        : and(ofAgent, eq(c.topicId, scope.topicId)),
    requester:
      scope.requesterUserId === null
        ? null
        : and(
            eq(c.workspaceId, scope.workspaceId),
            eq(c.requesterUserId, scope.requesterUserId),
          ),
  };
  const unknown = and(eq(c.state, "in_flight"), isNotNull(c.unknownAt));
  const otherTurn =
    scope.conversationTurnId === undefined
      ? undefined
      : or(
          isNull(c.conversationTurnId),
          ne(c.conversationTurnId, scope.conversationTurnId),
        );
  const counts: Record<string, ReturnType<typeof sql<number>>> = {};
  // A turn's calls count as the turn, once; a call of no turn as itself.
  const unit = sql`COALESCE(${c.conversationTurnId}, ${c.id})`;
  for (const limit of CONVERSATION_CALL_LIMIT_VALUES) {
    const where = scoped[limit];
    if (!where) continue;
    counts[limit] =
      sql<number>`(count(DISTINCT ${unit}) FILTER (WHERE ${where}))::int`;
    counts[`${limit}Unknown`] =
      sql<number>`(count(DISTINCT ${unit}) FILTER (WHERE ${and(where, unknown)}))::int`;
  }
  const [row] = await tx
    .select(counts)
    .from(c)
    .where(
      and(
        or(
          and(eq(c.state, "reserved"), gt(c.expiresAt, DB_NOW)),
          eq(c.state, "in_flight"),
        ),
        or(ofAgent, scoped.requester ?? undefined),
        otherTurn,
      ),
    );
  for (const limit of CONVERSATION_CALL_LIMIT_VALUES) {
    const inProgress = row?.[limit];
    if (inProgress === undefined) continue;
    if (inProgress >= CONVERSATION_CALL_LIMITS[limit]) {
      return {
        outcome: "concurrency_limited",
        limit,
        inProgress,
        unknown: row?.[`${limit}Unknown`] ?? 0,
      };
    }
  }
  return null;
}

// The first instant of the month (UTC) `at` falls in, as budget accounts
// cut months.
const monthStartOf = (at: Date) =>
  sql`(date_trunc('month', ${at.toISOString()}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/**
 * Whether a call counts as one of unknown price: what settled it, once a
 * report has; before, what priced the model it was issued for. A report an
 * older image settled writes no label: then a call issued for a priced model
 * counts when the report came to no amount, as one nothing prices does, so
 * a mixed rollout drops none of them. A row an older image issued has no
 * label at all and does not count.
 */
const UNKNOWN_PRICED = sql<boolean>`CASE
  WHEN ${conversationCalls.pricedBy} IS NOT NULL THEN ${conversationCalls.pricedBy} = 'unknown'
  WHEN ${conversationCalls.reservePricedBy} IS NULL OR ${conversationCalls.reservePricedBy} = 'unmetered' THEN false
  WHEN ${conversationCalls.reservePricedBy} = 'unknown' THEN true
  ELSE (${conversationCalls.state} = 'settled' AND ${conversationCalls.costUsd} = 0)
    OR ${budgetAdjustments.reportedCostUsd} = 0
  END`;

/**
 * The tokens of the conversation calls of unknown price (UNKNOWN_PRICED)
 * held on the account, or with none (null) the agent's calls held on none
 * made in the month `at` falls in: a held call's reserve, a settled one's
 * tokens, a resolved one's late report or else what its resolve charged. A
 * released call holds nothing. An account is one month's, whenever its calls
 * were made.
 */
export async function unknownPriceTokensIn(
  tx: Database,
  accountId: BudgetAccountId | null,
  agentId: string,
  at: Date,
): Promise<number> {
  const c = conversationCalls;
  const r = budgetReservations;
  const a = budgetAdjustments;
  const [row] = await tx
    .select({
      tokens: sql<string>`COALESCE(sum(CASE ${r.state}
        WHEN 'reserved' THEN ${r.tokens}
        WHEN 'settled' THEN ${r.settledTokens}
        WHEN 'resolved' THEN COALESCE(${a.reportedTokens}, ${r.settledTokens})
        ELSE 0 END), 0)::text`,
    })
    .from(c)
    .innerJoin(r, eq(r.callId, sql`${c.id}::text`))
    .leftJoin(a, eq(a.callId, r.callId))
    .where(
      and(
        UNKNOWN_PRICED,
        accountId === null
          ? and(
              isNull(r.accountId),
              eq(c.agentId, agentId),
              // A released call holds nothing; the period index skips it.
              ne(c.state, "released"),
              gte(c.createdAt, monthStartOf(at)),
            )
          : eq(r.accountId, accountId),
      ),
    );
  return Number(row?.tokens ?? 0);
}

/**
 * Whether one more call fits under the limit on tokens of unknown price, as
 * reserveBudgetIn asks it with the account's row locked, or with no account
 * under the agent's limit lock (holdConversationCallLimitsIn): so two calls
 * of one account, or of one agent on none, are judged in turn. The month's
 * marked tokens with this call's reserve, when its model is one nothing
 * prices, stay under the limit. A priced call adds nothing but is refused
 * once the month's reached it: a priced model can be answered by one nothing
 * prices, which settles with no amount. An unmetered call is not judged.
 *
 * The clock is read once, judging, and `createdAt` is it: the call is made
 * in the month it was judged in, so a call on no account counts in the month
 * the next one sums, however midnight falls. Unjudged, it is the time of the
 * insert, after the locks.
 */
function unknownPriceJudgeIn(
  tx: Database,
  call: {
    agentId: string;
    pricedBy: ConversationCallPricedBy;
    tokens: number;
    limit: number;
  },
): {
  admits: ((accountId: BudgetAccountId | null) => Promise<boolean>) | undefined;
  createdAt: () => Date | typeof DB_NOW;
} {
  let judgedAt: Date | undefined;
  const createdAt = () => judgedAt ?? DB_NOW;
  if (call.pricedBy === "unmetered") return { admits: undefined, createdAt };
  if (!Number.isSafeInteger(call.limit) || call.limit < 1) {
    throw new RangeError(
      `the limit on tokens of unknown price must be a positive integer: ${call.limit}`,
    );
  }
  return {
    admits: async (accountId) => {
      const at = await dbNow(tx);
      judgedAt = at;
      const held = await unknownPriceTokensIn(tx, accountId, call.agentId, at);
      const adding = call.pricedBy === "unknown" ? call.tokens : 0;
      return held + adding < call.limit;
    },
    createdAt,
  };
}

function issueIn(
  db: Database,
  input: ConversationCallIssueInput,
): Promise<ConversationCallIssue> {
  return db.transaction(async (tx): Promise<ConversationCallIssue> => {
    // Two issues of one key and attempt take it in turn, so the later one
    // reads the earlier one's row below whatever its account holds.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('conversation_call_key'), hashtext(${`${input.agentId}:${input.callKey}:${input.attempt}`}))`,
    );
    await lockBudgetCall(tx, input.callId);
    // Before the conversation's checks: a replay is one even once the
    // buffer has dropped the topic its call named.
    const [taken] = await tx
      .select({ id: conversationCalls.id })
      .from(conversationCalls)
      .where(
        and(
          eq(conversationCalls.agentId, input.agentId),
          eq(conversationCalls.callKey, input.callKey),
          eq(conversationCalls.attempt, input.attempt),
        ),
      );
    if (taken) return { outcome: "already_issued" };
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
    const [conversation] = await tx
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.agentId, input.agentId),
          eq(conversations.workspaceId, input.workspaceId),
        ),
      );
    if (!conversation) return { outcome: "unknown_conversation" };
    if (input.topicId !== null) {
      const [topic] = await tx
        .select({ id: conversationTopics.id })
        .from(conversationTopics)
        .where(
          and(
            eq(conversationTopics.id, input.topicId),
            eq(conversationTopics.conversationId, input.conversationId),
          ),
        )
        .for("key share");
      if (!topic) return { outcome: "unknown_conversation" };
    }
    const requesterUserId = requesterUserOf(input.root);
    const limited = await holdConversationCallLimitsIn(tx, {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      conversationKind: conversation.kind,
      topicId: input.topicId,
      callClass: input.callClass,
      requesterUserId,
    });
    if (limited) return limited;
    const choice = chooseBudgetAccount(input.root, agent.teamId);
    const judge = unknownPriceJudgeIn(tx, {
      agentId: input.agentId,
      pricedBy: input.pricedBy,
      tokens: input.reserve.tokens,
      limit: input.unknownPriceTokenLimit,
    });
    const reserved = await reserveBudgetIn(
      tx,
      {
        callId: input.callId,
        workspaceId: input.workspaceId,
        choice,
        reserve: input.reserve,
        unmetered: input.unmetered,
      },
      judge.admits,
    );
    if (reserved.outcome === "refused") {
      return {
        outcome: "refused",
        rootKind: choice.rootKind,
        accountId: reserved.accountId,
        by: reserved.by ?? "budget",
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
        requesterUserId,
        connectionId: input.connectionId,
        path: input.path,
        model: input.model,
        maxTokens: input.maxTokens,
        maxRequestBytes: input.maxRequestBytes,
        reservePricedBy: input.pricedBy,
        createdAt: judge.createdAt(),
        expiresAt: fromDbNow(input.ttlMs),
        conversationId: input.conversationId,
        topicId: input.topicId,
        callClass: input.callClass,
        releaseId: input.releaseId,
        callKey: input.callKey,
        attempt: input.attempt,
      })
      .returning({ expiresAt: conversationCalls.expiresAt });
    if (!row) throw new Error("conversation call row missing after insert");
    return { outcome: "issued", expiresAt: row.expiresAt };
  });
}

/**
 * Locks, in the one order every writer of a conversation call takes them:
 * an issue's lock on its key and attempt first, then budget-accounts.ts's
 * call lock, then this call's row, then its limit keys' locks
 * (holdConversationCallLimitsIn), then the reservation row and the account
 * row (the budget ledger's own order). The issue holds the account row while
 * it inserts the call's row, which no one can wait on before it commits. It
 * key-share locks the call's topic before that, so the buffer does not drop
 * the topic in between. A first grant takes the call's limit keys' locks and
 * then the call's row, never an account.
 */
/** Thrown to take back a mention's turn whose message another turn engaged first. */
class MentionEngaged extends Error {}

/** Thrown to take back an unasked turn whose judgment another one took first. */
class JudgmentTaken extends Error {}

/**
 * Why a turn cannot be written in its scope, or null when it can: the agent,
 * its conversation, and the topic, held so the buffer does not drop it
 * before the turn holds it.
 */
async function turnScopeIn(
  tx: Database,
  input: Pick<
    ConversationTurnPermitInput,
    "workspaceId" | "agentId" | "conversationId" | "topicId"
  >,
): Promise<Exclude<ConversationTurnPermitIssue, { outcome: "issued" }> | null> {
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(agents.workspaceId, input.workspaceId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);
  if (!agent) return { outcome: "unknown_agent" };
  const [conversation] = await tx
    .select({
      id: conversations.id,
      teamId: conversations.teamId,
      channelId: conversations.channelId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.agentId, input.agentId),
        eq(conversations.workspaceId, input.workspaceId),
      ),
    );
  if (!conversation) return { outcome: "unknown_conversation" };
  // An emergency stop holds the channel's binding while it ends the turns
  // there: a turn written first is ended by it, and one after it finds the
  // channel stopped.
  const bindings = rowsOf<{ stopped: boolean }>(
    await tx.execute(sql`
      SELECT emergency_stopped_at IS NOT NULL AS stopped
      FROM surface_bindings
      WHERE agent_id = ${input.agentId}::uuid
        AND external_surface_id = ${conversation.channelId}
        AND installation_id IN (
          SELECT id FROM slack_installations
          WHERE team_id = ${conversation.teamId})
        AND (revoked_at IS NULL OR emergency_stopped_at IS NOT NULL)
      ORDER BY id
      FOR SHARE`),
  );
  if (bindings.some((binding) => binding.stopped))
    return { outcome: "channel_stopped" };
  const [topic] = await tx
    .select({ id: conversationTopics.id })
    .from(conversationTopics)
    .where(
      and(
        eq(conversationTopics.id, input.topicId),
        eq(conversationTopics.conversationId, input.conversationId),
      ),
    )
    .for("key share");
  if (!topic) return { outcome: "unknown_conversation" };
  return null;
}

/** The permit of a turn written in `tx`. */
async function insertTurnPermitIn(
  tx: Database,
  input: Omit<ConversationTurnPermitInput, "requester" | "root">,
  root: BudgetRoot,
): Promise<ConversationTurnPermitIssue> {
  const [permit] = await tx
    .insert(conversationTurnPermits)
    .values({
      turnId: input.turnId,
      tokenHash: input.tokenHash,
      rootKind: chooseBudgetAccount(root, null).rootKind,
      requesterUserId: requesterUserOf(root),
      connectionId: input.connectionId,
      path: input.path,
      model: input.model,
      maxTokens: input.maxTokens,
      maxRequestBytes: input.maxRequestBytes,
      callKey: input.callKey,
      expiresAt: fromDbNow(input.ttlMs),
    })
    .returning({ expiresAt: conversationTurnPermits.expiresAt });
  if (!permit) throw new Error("turn permit row missing after insert");
  // The conversation's kind says what the turn may decide.
  const [conversation] = await tx
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId));
  if (conversation === undefined) {
    throw new Error(`conversation ${input.conversationId} is gone`);
  }
  return {
    outcome: "issued",
    expiresAt: permit.expiresAt,
    place: conversation.kind,
  };
}

export function createPostgresConversationCalls(
  db: Database,
): ConversationCallStore {
  return {
    issueAtomic: (input) => issueIn(db, input),

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
        // A first grant keeps an unexpired call counted by the limits; one
        // that expires while the grant waits for their locks is not bound,
        // as an issue under them may already have left it uncounted.
        const [unbound] = await tx
          .select({
            workspaceId: conversationCalls.workspaceId,
            agentId: conversationCalls.agentId,
            requesterUserId: conversationCalls.requesterUserId,
          })
          .from(conversationCalls)
          .where(
            and(
              eq(conversationCalls.tokenHash, input.tokenHash),
              eq(conversationCalls.state, "reserved"),
            ),
          );
        if (unbound) await lockConversationCallLimitsIn(tx, unbound);
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

    issueTurnPermitAtomic(input) {
      return db.transaction(
        async (tx): Promise<ConversationTurnPermitIssue> => {
          const refused = await turnScopeIn(tx, input);
          if (refused !== null) return refused;
          await tx.insert(conversationTurns).values({
            id: input.turnId,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            conversationId: input.conversationId,
            topicId: input.topicId,
            origin: "m2",
            state: "running",
            requesterKind: input.requester.kind,
            requesterId: input.requester.id,
            releaseId: input.releaseId,
          });
          return insertTurnPermitIn(tx, input, input.root);
        },
      );
    },

    issueMentionTurnAtomic(input) {
      const { message } = input;
      const sources = storedSourceSet({
        direct: [placeSource(message)],
        inherited: [],
        overflow: false,
      });
      return db
        .transaction(async (tx) => {
          const refused = await turnScopeIn(tx, input);
          if (refused !== null) return refused;
          // The message's mark lock first: a delete under way is waited for
          // and refuses the turn, and one after it finds the turn holding it.
          const deleted = await lockedDeletedSource(tx, {
            workspaceId: input.workspaceId,
            sessionId: null,
            sources,
            throughTurn: null,
          });
          if (deleted !== null) return { outcome: "source_deleted" as const };
          // A first try is taken only under the agent's rollout on; a try
          // again is written only while it still is. Shared, as a change of
          // the rollout writes the agent's row: one waits for the other.
          if (input.retryOf !== undefined) {
            const [agent] = await tx
              .select({ rollout: agents.conversationRollout })
              .from(agents)
              .where(eq(agents.id, input.agentId))
              .for("share");
            if (agent?.rollout !== "on")
              return { outcome: "rollout_off" as const };
            // The try it follows must still be ended as its pass read it,
            // read after the binding's lock, so after any stop: one a stop
            // ended (the channel on again since, or the binding above would
            // refuse) or one the queue forgot, its end no longer known,
            // leaves no try to follow it.
            const [before] = rowsOf<{ followed: boolean }>(
              await tx.execute(sql`
                SELECT state = 'ended'
                  AND outcome ->> 'reason' IS DISTINCT FROM 'emergency_stopped'
                  -- Nor one whose last line another pass wrote.
                  AND NOT EXISTS (SELECT 1 FROM slack_outbox o
                    WHERE o.dedupe_key = ${conversationReplyDedupeKey(input.retryOf)}) AS followed
                FROM conversation_turn_queue
                WHERE turn_id = ${input.retryOf}::uuid`),
            );
            if (before?.followed !== true)
              return { outcome: "channel_stopped" as const };
          }
          await tx.insert(conversationTurns).values({
            id: input.turnId,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            conversationId: input.conversationId,
            topicId: input.topicId,
            origin: "m2",
            state: "running",
            requesterKind: "user",
            requesterId: input.requesterUserId,
            sources,
            releaseId: input.releaseId,
            slackInstallationId: input.slackInstallationId,
            slackSubject: input.slackSubject ?? null,
            // Its writer's until queued: no pass ends it in between.
            slackStatusClaimedAt: sql`now()`,
          });
          // A retry of the event, or two passes at once, meets the first
          // turn's engagement: this turn goes back with the transaction.
          const [engaged] =
            input.retryOf === undefined
              ? await tx
                  .insert(conversationEngagements)
                  .values({
                    workspaceId: input.workspaceId,
                    agentId: input.agentId,
                    teamId: message.teamId,
                    channelId: message.channelId,
                    ts: message.ts,
                    kind: "mention",
                    conversationTurnId: input.turnId,
                  })
                  .onConflictDoNothing()
                  .returning({ ts: conversationEngagements.ts })
              : // A try again moves the engagement off the try it follows,
                // once: a second pass finds it moved and takes this one back.
                await tx
                  .update(conversationEngagements)
                  .set({ conversationTurnId: input.turnId })
                  .where(
                    and(
                      eq(conversationEngagements.agentId, input.agentId),
                      eq(conversationEngagements.teamId, message.teamId),
                      eq(conversationEngagements.channelId, message.channelId),
                      eq(conversationEngagements.ts, message.ts),
                      eq(conversationEngagements.kind, "mention"),
                      eq(
                        conversationEngagements.conversationTurnId,
                        input.retryOf,
                      ),
                    ),
                  )
                  .returning({ ts: conversationEngagements.ts });
          if (engaged === undefined) throw new MentionEngaged();
          if (input.retryOf !== undefined) {
            // The try it follows no longer holds the thread's "processing":
            // this one does, until it ends.
            await tx
              .update(conversationTurns)
              .set({ slackStatusResetAt: sql`now()` })
              .where(
                and(
                  eq(conversationTurns.id, input.retryOf),
                  isNull(conversationTurns.slackStatusResetAt),
                ),
              );
          }
          return insertTurnPermitIn(tx, input, {
            kind: "user",
            userId: input.requesterUserId,
          });
        })
        .catch((error: unknown) => {
          if (error instanceof MentionEngaged) {
            return { outcome: "duplicate" as const };
          }
          throw error;
        });
    },

    issueUnsolicitedTurnAtomic(input) {
      const sources = storedSourceSet({
        direct: input.sources.map((ts) =>
          placeSource({ teamId: input.teamId, channelId: input.channelId, ts }),
        ),
        inherited: [],
        overflow: false,
      });
      return db
        .transaction(async (tx): Promise<ConversationUnsolicitedTurnIssue> => {
          // Unlocked, before the scope: a record of `shadow` kept no topic
          // for a turn. Read again under its lock below.
          const [before] = await tx
            .select({ rollout: agents.conversationRollout })
            .from(agents)
            .where(eq(agents.id, input.agentId));
          if (before !== undefined && before.rollout !== "on") {
            return { outcome: "rollout_off" };
          }
          const refused = await turnScopeIn(tx, input);
          if (refused !== null) return refused;
          // The posts' mark locks first, as a mention's turn takes its own: a
          // delete under way refuses the turn, one after it finds it.
          const deleted = await lockedDeletedSource(tx, {
            workspaceId: input.workspaceId,
            sessionId: null,
            sources,
            throughTurn: null,
          });
          if (deleted !== null) return { outcome: "source_deleted" };
          // Only under the rollout on; `shadow` judges for the record alone.
          // Locks in a mention's try again order: the scope's, the marks,
          // the agent.
          const [agent] = await tx
            .select({
              rollout: agents.conversationRollout,
              status: agents.status,
            })
            .from(agents)
            .where(eq(agents.id, input.agentId))
            .for("share");
          if (agent?.rollout !== "on") return { outcome: "rollout_off" };
          // Still heard as the buffer hears it: an active agent in a channel
          // not archived.
          const [heard] = await tx
            .select({ state: conversations.channelState })
            .from(conversations)
            .where(eq(conversations.id, input.conversationId));
          if (agent.status !== "active" || heard?.state !== "active") {
            return { outcome: "no_binding" };
          }
          // The channel's live binding, held as an admin's change of it waits.
          // It still listens to what was judged: a batch's posts only while
          // it hears every post, a reply held for its own judgment (engaged,
          // or of work done) also while it hears mentions and their threads.
          const [binding] = rowsOf<{ installation_id: string }>(
            await tx.execute(sql`
              SELECT b.installation_id
              FROM surface_bindings b
              JOIN slack_installations i ON i.id = b.installation_id
              WHERE b.agent_id = ${input.agentId}::uuid AND b.surface = 'slack'
                AND b.external_surface_id = ${input.channelId}
                AND i.team_id = ${input.teamId}
                AND b.revoked_at IS NULL AND b.status = 'ready'
                AND b.mode = 'on'
                AND (b.listen = 'free' OR (b.listen = 'mention' AND EXISTS (
                  SELECT 1 FROM conversation_judgments j
                  WHERE j.id = ${input.judgmentId}::uuid
                    AND j.grade IN ('m1_engaged', 'm1', 'm1_to_task'))))
                AND NOT b.external_shared AND b.emergency_stopped_at IS NULL
              ORDER BY b.id
              LIMIT 1
              FOR SHARE OF b`),
          );
          if (binding === undefined) return { outcome: "no_binding" };
          const untaken = sql`NOT EXISTS (
            SELECT 1 FROM conversation_inputs i
            WHERE i.agent_id = ${input.agentId}::uuid
              AND i.slack_team_id = ${input.teamId}
              AND i.slack_channel_id = ${input.channelId}
              AND i.slack_ts = conversation_judgments.target_ts
              AND i.turn_id IS NOT NULL)`;
          // The admission of the work the reply was held for (its session as
          // the receive path read it; on a record from before that was kept,
          // the thread's latest link by the time it was held), read unlocked:
          // a close that fails back to open work after this is 94S-2519's,
          // and a session taking the reply then is refused by its answered
          // judgment (takeSlackTurnInput). The receive path waits out a
          // closing, so a close failing back before this leaves the reply to
          // the work. No session there is closed work, as sessionWorkClosed
          // reads it.
          const workClosed = sql`COALESCE(CASE
            WHEN conversation_judgments.work_session_id IS NOT NULL THEN (
              SELECT s.admission_state FROM sessions s
              WHERE s.id = conversation_judgments.work_session_id)
            ELSE ${threadWorkAdmission(
              sql`${input.agentId}::uuid`,
              sql`${input.topicId}::uuid`,
              sql`(SELECT i.received_at FROM conversation_inputs i
                WHERE i.agent_id = ${input.agentId}::uuid
                  AND i.slack_team_id = ${input.teamId}
                  AND i.slack_channel_id = ${input.channelId}
                  AND i.slack_ts = conversation_judgments.target_ts)`,
            )} END, 'closed') IN (${sql.join(
              CLOSED_WORK_ADMISSION_STATES.map((state) => sql`${state}`),
              sql`, `,
            )})`;
          await tx.insert(conversationTurns).values({
            id: input.turnId,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            conversationId: input.conversationId,
            topicId: input.topicId,
            origin: "m2",
            state: "running",
            // No one asked: the agent's own turn, charged as root none.
            requesterKind: "agent",
            requesterId: input.agentId,
            sources,
            releaseId: input.releaseId,
            slackInstallationId: binding.installation_id,
            // Its writer's until queued: no pass ends it in between.
            slackStatusClaimedAt: sql`now()`,
          });
          const taken = rowsOf(
            await tx.execute(sql`
              UPDATE conversation_judgments SET turn_id = ${input.turnId}::uuid
              WHERE id = ${input.judgmentId}::uuid
                AND agent_id = ${input.agentId}::uuid
                -- A post a session's turn took already is the session's to
                -- answer: of a bound thread, only a reply of work done that
                -- none took (v1-b/U1 B), or one of work going on that none
                -- took and whose work closed while it waited (94S-2506),
                -- never one of work still going on. A session that takes the
                -- post after this turn is not barred here: work done
                -- (closing, closed) takes no turn, and the receive path
                -- sends no answered hold to the work.
                AND (grade IN ('buffer_m1', 'm1_engaged')
                  OR (grade = 'm1' AND ${untaken})
                  OR (grade = 'm1_to_task' AND ${untaken} AND ${workClosed}))
                AND decision = 'speak' AND target_ts IS NOT NULL
                AND turn_id IS NULL AND answer IS NULL
                -- One unasked turn a reply: the same post held again (a
                -- second event of it) is not answered twice. The post's
                -- mark, locked above, orders two such issues.
                AND NOT (grade IN ('m1', 'm1_engaged', 'm1_to_task') AND EXISTS (
                  SELECT 1 FROM conversation_judgments o
                  WHERE o.agent_id = ${input.agentId}::uuid
                    AND o.slack_team_id = ${input.teamId}
                    AND o.slack_channel_id = ${input.channelId}
                    AND o.target_ts = conversation_judgments.target_ts
                    AND o.grade IN ('m1', 'm1_engaged', 'm1_to_task')
                    AND o.turn_id IS NOT NULL
                    AND o.id <> conversation_judgments.id))
              RETURNING id`),
          );
          if (taken.length === 0) throw new JudgmentTaken();
          return insertTurnPermitIn(tx, input, { kind: "none" });
        })
        .catch((error: unknown) => {
          if (error instanceof JudgmentTaken) {
            return { outcome: "duplicate" as const };
          }
          throw error;
        });
    },

    authorizeTurnCallAtomic(input) {
      const granted = db.transaction(
        async (tx): Promise<ConversationTurnCallAuthorization> => {
          const p = conversationTurnPermits;
          const t = conversationTurns;
          const c = conversationCalls;
          // Every call of one turn takes the permit's row in turn, so each
          // is numbered once and a turn's end waits for a call being written.
          const [permit] = await tx
            .select({
              turnId: p.turnId,
              rootKind: p.rootKind,
              requesterUserId: p.requesterUserId,
              connectionId: p.connectionId,
              path: p.path,
              model: p.model,
              maxTokens: p.maxTokens,
              maxRequestBytes: p.maxRequestBytes,
              callKey: p.callKey,
              calls: p.calls,
              expiresAt: p.expiresAt,
              workspaceId: t.workspaceId,
              agentId: t.agentId,
              conversationId: t.conversationId,
              topicId: t.topicId,
              releaseId: t.releaseId,
            })
            .from(p)
            .innerJoin(t, eq(t.id, p.turnId))
            .where(eq(p.tokenHash, input.tokenHash))
            .for("update", { of: p });
          if (!permit) return { outcome: "invalid_token" };
          const limits = {
            callId: c.id,
            connectionId: c.connectionId,
            path: c.path,
            model: c.model,
            maxTokens: c.maxTokens,
            maxRequestBytes: c.maxRequestBytes,
          };
          // Read after the lock, not in its statement (db-clock.ts).
          const now = await dbNow(tx);
          // Its own statement: a turn ended while this waited on the permit
          // reads as running in the statement that took it.
          const [turn] = await tx
            .select({ state: t.state })
            .from(t)
            .where(eq(t.id, permit.turnId));
          // A decided turn's engine still closes it: its provider calls only,
          // as a tool call on it is refused (admit), and none once it ends,
          // a regrant of one under way included (an emergency stop ends it).
          if (turn?.state !== "running" && turn?.state !== "decided") {
            return { outcome: "invalid_token" };
          }
          // The proxy's regrant of a call already made on the permit.
          const [again] = await tx
            .select(limits)
            .from(c)
            .where(
              and(
                eq(c.exchangeId, input.exchangeId),
                eq(c.conversationTurnId, permit.turnId),
                eq(c.state, "in_flight"),
                gt(c.expiresAt, DB_NOW),
              ),
            )
            .limit(1);
          if (again) return { outcome: "ok", turnId: permit.turnId, ...again };
          if (permit.expiresAt <= now) return { outcome: "invalid_token" };
          const [taken] = await tx
            .select({ id: c.id })
            .from(c)
            .where(eq(c.exchangeId, input.exchangeId))
            .limit(1);
          if (taken) return { outcome: "invalid_token" };
          // The server's own count of the turn's calls, behind the runtime's:
          // one past it is refused before anything is held.
          if (permit.calls >= CONVERSATION_TURN_MODEL_CALL_LIMIT) {
            await tx
              .update(p)
              .set({ refusal: "turn_limit" })
              .where(eq(p.turnId, permit.turnId));
            return { outcome: "turn_limited", turnId: permit.turnId };
          }
          const held = input.reserveFor(permit);
          if (held === null) return { outcome: "unavailable" };
          const [conversation] = await tx
            .select({ kind: conversations.kind })
            .from(conversations)
            .where(eq(conversations.id, permit.conversationId));
          if (!conversation) return { outcome: "invalid_token" };
          await lockBudgetCall(tx, input.callId);
          const refuse = (refusal: ConversationTurnCallRefusal) =>
            tx.update(p).set({ refusal }).where(eq(p.turnId, permit.turnId));
          const limited = await holdConversationCallLimitsIn(tx, {
            workspaceId: permit.workspaceId,
            agentId: permit.agentId,
            conversationId: permit.conversationId,
            conversationKind: conversation.kind,
            topicId: permit.topicId,
            callClass: "m2",
            requesterUserId: permit.requesterUserId,
            conversationTurnId: permit.turnId,
          });
          if (limited) {
            await refuse("concurrency");
            return { ...limited, turnId: permit.turnId };
          }
          // The agent's team, as an issue chooses it.
          const [agent] = await tx
            .select({
              teamId: sql<
                string | null
              >`CASE WHEN ${memberTeams.archivedAt} IS NULL THEN ${memberTeams.id} END`,
            })
            .from(agents)
            .leftJoin(memberTeams, eq(memberTeams.id, agents.managingTeamId))
            .where(and(eq(agents.id, permit.agentId), isNull(agents.deletedAt)))
            .limit(1);
          const teamId = agent?.teamId ?? null;
          // The permit kept the person whenever its root chose one.
          const choice: BudgetChoice = {
            rootKind: permit.rootKind,
            owner:
              permit.requesterUserId !== null
                ? { kind: "user", userId: permit.requesterUserId }
                : teamId === null
                  ? null
                  : { kind: "team", teamId },
          };
          const judge = unknownPriceJudgeIn(tx, {
            agentId: permit.agentId,
            pricedBy: held.pricedBy,
            tokens: held.reserve.tokens,
            limit: input.unknownPriceTokenLimit,
          });
          const reserved = await reserveBudgetIn(
            tx,
            {
              callId: input.callId,
              workspaceId: permit.workspaceId,
              choice,
              reserve: held.reserve,
              unmetered: held.unmetered,
            },
            judge.admits,
          );
          if (reserved.outcome === "refused") {
            // Kept as a budget refusal: the permit's refusal values are
            // what an older image reads and its CHECK holds.
            await refuse("budget");
            return {
              outcome: "refused",
              turnId: permit.turnId,
              rootKind: choice.rootKind,
              accountId: reserved.accountId,
              by: reserved.by ?? "budget",
            };
          }
          if (reserved.outcome !== "reserved") {
            throw new Error(
              `conversation call ${input.callId}: its id was already reserved`,
            );
          }
          // The lock waits above may have outlived the permit.
          if (permit.expiresAt <= (await dbNow(tx)))
            throw new TurnPermitLapsed();
          const [row] = await tx
            .insert(c)
            .values({
              id: input.callId,
              workspaceId: permit.workspaceId,
              agentId: permit.agentId,
              // No token stands for one call of a turn: the permit does.
              tokenHash: randomBytes(32),
              rootKind: choice.rootKind,
              requesterUserId: permit.requesterUserId,
              connectionId: permit.connectionId,
              path: permit.path,
              model: permit.model,
              maxTokens: permit.maxTokens,
              maxRequestBytes: permit.maxRequestBytes,
              reservePricedBy: held.pricedBy,
              state: "in_flight",
              createdAt: judge.createdAt(),
              exchangeId: input.exchangeId,
              startedAt: DB_NOW,
              expiresAt: permit.expiresAt,
              conversationId: permit.conversationId,
              topicId: permit.topicId,
              callClass: "m2",
              releaseId: permit.releaseId,
              callKey: permit.callKey,
              attempt: permit.calls + 1,
              conversationTurnId: permit.turnId,
            })
            .returning(limits);
          if (!row)
            throw new Error("conversation call row missing after insert");
          await tx
            .update(p)
            .set({ calls: permit.calls + 1 })
            .where(eq(p.turnId, permit.turnId));
          return { outcome: "ok", turnId: permit.turnId, ...row };
        },
      );
      return granted.catch((error: unknown) => {
        if (error instanceof TurnPermitLapsed) {
          return { outcome: "invalid_token" as const };
        }
        throw error;
      });
    },

    async boundTurnPermitAtomic({ turnId, until }) {
      await db
        .update(conversationTurnPermits)
        .set({
          expiresAt: sql`LEAST(${conversationTurnPermits.expiresAt}, ${until.toISOString()}::timestamptz)`,
        })
        .where(eq(conversationTurnPermits.turnId, turnId));
    },

    endTurnAtomic({ turnId, limitReached }) {
      return db.transaction(async (tx) => {
        const p = conversationTurnPermits;
        // The permit first, as a call on it takes it.
        const [permit] = await tx
          .select({ refusal: p.refusal, toolCalls: p.toolCalls })
          .from(p)
          .where(eq(p.turnId, turnId))
          .for("update");
        const refusal = permit?.refusal ?? null;
        // The refused call is counted too: past the limit means one was.
        const toolCallRefused =
          (permit?.toolCalls ?? 0) > CONVERSATION_TURN_TOOL_CALL_LIMIT;
        const [turn] = await tx
          .select({ state: conversationTurns.state })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.id, turnId),
              eq(conversationTurns.origin, "m2"),
            ),
          )
          .for("update");
        if (!turn) {
          return { ended: "gone" as const, state: null, refusal, limit: null };
        }
        // A decided turn's permit took its last provider calls: it ends here.
        await tx
          .update(p)
          .set({ expiresAt: sql`LEAST(${p.expiresAt}, ${DB_NOW})` })
          .where(eq(p.turnId, turnId));
        if (turn.state !== "running") {
          return {
            ended: "already_ended" as const,
            state: turn.state,
            refusal,
            limit: null,
          };
        }
        const limit = limitReached?.(refusal, toolCallRefused) ?? null;
        await tx
          .update(conversationTurns)
          .set({
            state: "no_decision",
            endedAt: DB_NOW,
            limitReached: limit?.limit ?? null,
            limitReachedBy: limit?.by ?? null,
          })
          .where(eq(conversationTurns.id, turnId));
        return {
          ended: "recorded" as const,
          state: "no_decision" as const,
          refusal,
          limit,
        };
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
        const [reservation] = await tx
          .select({ unmetered: budgetReservations.unmetered })
          .from(budgetReservations)
          .where(eq(budgetReservations.callId, input.callId));
        const unmetered = reservation?.unmetered ?? false;
        if (call.state === "settled") {
          return Bun.deepEquals(call.usage, input.usage)
            ? {
                outcome: "already_settled",
                costUsd: call.costUsd ?? 0,
                unmetered,
                model: call.model,
                pricedBy: call.pricedBy,
              }
            : { outcome: "conflict" };
        }
        const priced = unmetered
          ? { costUsd: 0, pricedBy: "unmetered" as const }
          : input.priceFor({ unmetered, model: call.model });
        const costUsd = unmetered ? 0 : toStoredCost(priced.costUsd);
        if (call.state === "resolved") {
          // An operator closed it while its end was unknown: it stays closed,
          // and the report adds the call's one adjustment to its account,
          // and says what priced it: a report again answers with that.
          const adjusted = await settleBudgetIn(tx, {
            callId: input.callId,
            actual: { costUsd, tokens: reservationTokens(input.usage) },
          });
          if (adjusted === "adjusted") {
            await tx
              .update(conversationCalls)
              .set({ pricedBy: priced.pricedBy })
              .where(eq(conversationCalls.id, input.callId));
            return {
              outcome: "settled",
              costUsd,
              unmetered,
              model: call.model,
              pricedBy: priced.pricedBy,
            };
          }
          if (adjusted !== "already_adjusted") {
            throw new Error(
              `conversation call ${input.callId}: its resolved reservation was ${adjusted}`,
            );
          }
          const [first] = await tx
            .select({ costUsd: budgetAdjustments.reportedCostUsd })
            .from(budgetAdjustments)
            .where(eq(budgetAdjustments.callId, input.callId));
          return {
            outcome: "already_settled",
            costUsd: first?.costUsd ?? 0,
            unmetered,
            model: call.model,
            pricedBy: call.pricedBy,
          };
        }
        // Bound and not settled is in flight, its end unknown or not, held
        // either way: a release takes only an unbound row. A late report
        // settles an unknown one at what it says.
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
            pricedBy: priced.pricedBy,
            endedAt: DB_NOW,
            unknownAt: null,
          })
          .where(eq(conversationCalls.id, input.callId));
        return {
          outcome: "settled",
          costUsd,
          unmetered,
          model: call.model,
          pricedBy: priced.pricedBy,
        };
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

    async markUnknown({ limit, dryRun }) {
      const past = sql`${conversationCalls.startedAt} < ${fromDbNow(-PROVIDER_EXCHANGE_LEASE_MS)}`;
      const stale = await db
        .select({ id: conversationCalls.id })
        .from(conversationCalls)
        .where(
          and(
            eq(conversationCalls.state, "in_flight"),
            isNull(conversationCalls.unknownAt),
            past,
          ),
        )
        .orderBy(conversationCalls.startedAt)
        .limit(limit);
      if (dryRun) return { unknown: stale.length };
      let unknown = 0;
      for (const { id } of stale) {
        const done = await db.transaction(async (tx) => {
          await lockBudgetCall(tx, id);
          // Judged again under the call's lock: a report that settled it
          // since keeps it.
          const [call] = await tx
            .update(conversationCalls)
            .set({ unknownAt: DB_NOW })
            .where(
              and(
                eq(conversationCalls.id, id),
                eq(conversationCalls.state, "in_flight"),
                isNull(conversationCalls.unknownAt),
                past,
              ),
            )
            .returning({ id: conversationCalls.id });
          if (!call) return false;
          await markBudgetUnknownIn(tx, id, true);
          return true;
        });
        if (done) unknown++;
      }
      return { unknown };
    },

    async unknownByAgent({ atLeast, limit }) {
      const unknown = sql<number>`count(*)::int`;
      return db
        .select({
          workspaceId: conversationCalls.workspaceId,
          agentId: conversationCalls.agentId,
          unknown,
        })
        .from(conversationCalls)
        .where(
          and(
            eq(conversationCalls.state, "in_flight"),
            isNotNull(conversationCalls.unknownAt),
          ),
        )
        .groupBy(conversationCalls.workspaceId, conversationCalls.agentId)
        .having(sql`count(*) >= ${atLeast}`)
        .orderBy(desc(unknown), conversationCalls.agentId)
        .limit(limit);
    },
  };
}
