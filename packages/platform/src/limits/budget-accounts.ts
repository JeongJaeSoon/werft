import {
  type BudgetRootKind,
  type TurnRequester,
  userIdSchema,
} from "@werft-ai/contracts";
import type { BudgetAmount } from "./ports/budget-ledger.ts";

/**
 * The root of the chain a call serves. A key is the API key that started
 * it: `personal` keys charge the person who made them, every other key
 * (an agent's, an operator's, an old one nobody made) the agent's team.
 */
export type BudgetRoot =
  | { kind: "user"; userId: string }
  | {
      kind: "key";
      keyKind: "personal" | "agent" | "operator";
      createdByUserId: string | null;
    }
  // An allowed Slack bot's message: an outside request, charged as a key
  // with no person.
  | { kind: "slack_bot" }
  | { kind: "none" };

export type BudgetOwner =
  | { kind: "user"; userId: string }
  | { kind: "team"; teamId: string };

/**
 * Where a call is charged, and the root kind kept beside it: a personal
 * key's call is `key` charged to a person. `owner` is null for a key or
 * an agent with no team.
 */
export type BudgetChoice = {
  rootKind: BudgetRootKind;
  owner: BudgetOwner | null;
};

/**
 * `agentTeamId` is the agent's team as the caller read it, null when it
 * has none to charge.
 */
export function chooseBudgetAccount(
  root: BudgetRoot,
  agentTeamId: string | null,
): BudgetChoice {
  const team: BudgetOwner | null =
    agentTeamId === null ? null : { kind: "team", teamId: agentTeamId };
  switch (root.kind) {
    case "user":
      return { rootKind: "user", owner: { kind: "user", userId: root.userId } };
    case "key":
      return {
        rootKind: "key",
        owner:
          root.keyKind === "personal" && root.createdByUserId !== null
            ? { kind: "user", userId: root.createdByUserId }
            : team,
      };
    case "slack_bot":
      return { rootKind: "slack_bot", owner: team };
    case "none":
      return { rootKind: "none", owner: team };
  }
}

/** A turn's requester columns as stored, its credential unparsed. */
export type StoredTurnRequester = {
  requesterKind: string | null;
  requesterId: string | null;
  requesterAuth: unknown;
};

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The root a running turn's calls are charged to. A push follow-up is the
 * agent's turn, and its root is the push request's (requester_auth.root);
 * every other turn, a carried one too, holds its root in its own columns.
 * Null when they say nothing this can read: such a call is held on the
 * session's limit alone, never refused as the agent's own work.
 */
export function budgetRootOfTurn(turn: StoredTurnRequester): BudgetRoot | null {
  const auth = objectOf(turn.requesterAuth);
  if (auth?.method !== "push_decision") return rootOfColumns(turn);
  const root = objectOf(auth.root);
  if (root === null) return null;
  const asked = {
    requesterKind:
      typeof root.requester_kind === "string" ? root.requester_kind : null,
    requesterId:
      typeof root.requester_id === "string" ? root.requester_id : null,
    requesterAuth: root.requester_auth ?? null,
  };
  // Roots never nest; one that says it is a push decision is not read.
  if (objectOf(asked.requesterAuth)?.method === "push_decision") return null;
  return rootOfColumns(asked);
}

function rootOfColumns(turn: StoredTurnRequester): BudgetRoot | null {
  const kind = turn.requesterKind as TurnRequester["kind"] | null;
  const method = objectOf(turn.requesterAuth)?.method;
  switch (kind) {
    case "user": {
      const userId = userIdSchema.safeParse(turn.requesterId);
      if (!userId.success) return null;
      // A personal key's requester is the person who made it.
      return method === "personal_key"
        ? { kind: "key", keyKind: "personal", createdByUserId: userId.data }
        : { kind: "user", userId: userId.data };
    }
    case "api_key":
      return {
        kind: "key",
        keyKind: method === "agent_key" ? "agent" : "operator",
        createdByUserId: null,
      };
    case "slack_bot":
      return { kind: "slack_bot" };
    case "agent":
      return { kind: "none" };
    default:
      return null;
  }
}

/** Either limit may be unset; a row with neither limits nothing. */
export type BudgetLimit = { costUsd: number | null; tokens: number | null };

/**
 * A person's own limit, whatever it says, wins over the workspace's limit
 * for every person; with neither the person has no limit.
 */
export function personLimitOf(
  own: BudgetLimit | null,
  workspaceDefault: BudgetLimit | null,
): BudgetLimit | null {
  return own ?? workspaceDefault;
}

/** One account period as its row keeps it. */
export type BudgetHeld = { spent: BudgetAmount; reserved: BudgetAmount };

/**
 * The share of a limit, in percent, past which a reserve of root kind
 * `none` (no person and no key behind it) is refused (decision 31): the
 * agent's own work stops first and leaves the rest of the month to the
 * people and keys the account also serves.
 */
export const ROOT_NONE_LIMIT_PERCENT = 80;

/**
 * Whether one more reserve fits. Without a limit (no account, or one with
 * no limit) only the agent's own work is refused: a person's and a key's
 * calls run and are recorded. With one, spent, held (an unknown end
 * included) and the new reserve together must stay under it, the predicate
 * the session limits use (limitsReached): a limit is reached once the sum
 * gets to it. Root kind `none` is held to ROOT_NONE_LIMIT_PERCENT of it.
 */
export function admitsBudgetReserve(input: {
  rootKind: BudgetRootKind;
  limit: BudgetLimit | null;
  held: BudgetHeld | null;
  reserve: BudgetAmount;
}): boolean {
  const { limit, held, reserve } = input;
  if (limit === null || (limit.costUsd === null && limit.tokens === null)) {
    return input.rootKind !== "none";
  }
  // Summed as integers, micro-USD at the columns' scale, so a sum that
  // reaches the limit exactly is never read as just under it.
  const sum = (pick: (amount: BudgetAmount) => number) =>
    [held?.spent, held?.reserved, reserve].reduce(
      (total, amount) => total + (amount ? BigInt(pick(amount)) : 0n),
      0n,
    );
  const percent = BigInt(
    input.rootKind === "none" ? ROOT_NONE_LIMIT_PERCENT : 100,
  );
  // sum / limit >= percent / 100, in integers.
  const reached = (used: bigint, limitOf: bigint) =>
    used * 100n >= limitOf * percent;
  const costMicros = sum((amount) => microsOf(amount.costUsd));
  const tokens = sum((amount) => amount.tokens);
  if (
    limit.costUsd !== null &&
    reached(costMicros, BigInt(microsOf(limit.costUsd)))
  )
    return false;
  if (limit.tokens !== null && reached(tokens, BigInt(limit.tokens)))
    return false;
  return true;
}

/** A cost at the ledger's scale (six decimals), as an integer. */
export const microsOf = (costUsd: number): number =>
  Math.round(costUsd * 1_000_000);

/**
 * Refuses what the ledger must not hold: a cost that is not a finite,
 * non-negative number, or tokens that are not a non-negative safe integer.
 * A NaN would pass every comparison and turn a limit off.
 */
export function assertBudgetAmount(amount: {
  costUsd: number | null;
  tokens: number | null;
}): void {
  const { costUsd, tokens } = amount;
  if (costUsd !== null && !(Number.isFinite(costUsd) && costUsd >= 0)) {
    throw new RangeError(
      `budget cost must be a finite amount >= 0: ${costUsd}`,
    );
  }
  if (tokens !== null && !(Number.isSafeInteger(tokens) && tokens >= 0)) {
    throw new RangeError(
      `budget tokens must be a safe integer >= 0: ${tokens}`,
    );
  }
}
