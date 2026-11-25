import type { BudgetOwnerKind } from "@werft-ai/contracts";

/**
 * A failed turn a monthly budget account refused: whose account, and
 * whether it is the session's first refusal while the limit holds (no
 * refusal on an earlier turn since the last completed one, in the same UTC
 * month). The first is told in the thread; a later one only to the person
 * who asked, except in a direct message, where every one is.
 */
export type BudgetRefusalOfTurn = { owner: BudgetOwnerKind; first: boolean };
