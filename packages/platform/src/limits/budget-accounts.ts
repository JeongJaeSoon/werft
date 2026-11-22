import type { BudgetRootKind } from "@werft-ai/contracts";
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
    case "none":
      return { rootKind: "none", owner: team };
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
 * Whether one more reserve fits. Without a limit (no account, or one with
 * no limit) only the agent's own work is refused: a person's and a key's
 * calls run and are recorded. With one, spent, held and the new reserve
 * together must stay under it, the predicate the session limits use
 * (limitsReached): a limit is reached once the sum gets to it.
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
  const costMicros = sum((amount) => microsOf(amount.costUsd));
  const tokens = sum((amount) => amount.tokens);
  if (limit.costUsd !== null && costMicros >= BigInt(microsOf(limit.costUsd)))
    return false;
  if (limit.tokens !== null && tokens >= BigInt(limit.tokens)) return false;
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
    throw new RangeError(`budget cost must be a finite amount >= 0: ${costUsd}`);
  }
  if (tokens !== null && !(Number.isSafeInteger(tokens) && tokens >= 0)) {
    throw new RangeError(`budget tokens must be a safe integer >= 0: ${tokens}`);
  }
}
