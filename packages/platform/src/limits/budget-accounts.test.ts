import { describe, expect, test } from "bun:test";
import {
  admitsBudgetReserve,
  assertBudgetAmount,
  type BudgetChoice,
  type BudgetRoot,
  chooseBudgetAccount,
  personLimitOf,
} from "./budget-accounts.ts";

const PERSON = "11111111-1111-4111-8111-111111111111";
const MAKER = "22222222-2222-4222-8222-222222222222";
const TEAM = "33333333-3333-4333-8333-333333333333";

describe("chooseBudgetAccount", () => {
  // Root, the agent's team, and the account and root kind it gives. Who
  // queued the turn is not an input: a continuation or a push follow-up
  // passes its root's person.
  const cases: [string, BudgetRoot, string | null, BudgetChoice][] = [
    [
      "a person's turn, and every turn that follows from it",
      { kind: "user", userId: PERSON },
      TEAM,
      { rootKind: "user", owner: { kind: "user", userId: PERSON } },
    ],
    [
      "a personal key: the person who made it",
      { kind: "key", keyKind: "personal", createdByUserId: MAKER },
      TEAM,
      { rootKind: "key", owner: { kind: "user", userId: MAKER } },
    ],
    [
      "an agent key, though a person made it: the agent's team",
      { kind: "key", keyKind: "agent", createdByUserId: MAKER },
      TEAM,
      { rootKind: "key", owner: { kind: "team", teamId: TEAM } },
    ],
    [
      "an operator key: the agent's team",
      { kind: "key", keyKind: "operator", createdByUserId: null },
      TEAM,
      { rootKind: "key", owner: { kind: "team", teamId: TEAM } },
    ],
    [
      "a key of an agent with no team: no account, still a key",
      { kind: "key", keyKind: "agent", createdByUserId: null },
      null,
      { rootKind: "key", owner: null },
    ],
    [
      "no person and no key: the agent's team",
      { kind: "none" },
      TEAM,
      { rootKind: "none", owner: { kind: "team", teamId: TEAM } },
    ],
    [
      "no person, no key, no team",
      { kind: "none" },
      null,
      { rootKind: "none", owner: null },
    ],
  ];
  for (const [name, root, team, expected] of cases) {
    test(name, () => {
      expect(chooseBudgetAccount(root, team)).toEqual(expected);
    });
  }
});

describe("personLimitOf", () => {
  const own = { costUsd: 5, tokens: null };
  const fallback = { costUsd: 20, tokens: 1_000 };
  test("a person's own limit wins", () => {
    expect(personLimitOf(own, fallback)).toEqual(own);
  });
  test("else the workspace's limit for every person", () => {
    expect(personLimitOf(null, fallback)).toEqual(fallback);
  });
  test("with neither, no limit", () => {
    expect(personLimitOf(null, null)).toBeNull();
  });
});

describe("assertBudgetAmount", () => {
  test("refuses what would turn a limit off or lose precision", () => {
    for (const amount of [
      { costUsd: Number.NaN, tokens: 0 },
      { costUsd: Number.POSITIVE_INFINITY, tokens: 0 },
      { costUsd: -1, tokens: 0 },
      { costUsd: 0, tokens: 1.5 },
      { costUsd: 0, tokens: -1 },
      { costUsd: 0, tokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => assertBudgetAmount(amount)).toThrow(RangeError);
    }
    expect(() =>
      assertBudgetAmount({ costUsd: 0.5, tokens: 10 }),
    ).not.toThrow();
    expect(() =>
      assertBudgetAmount({ costUsd: null, tokens: null }),
    ).not.toThrow();
  });
});

describe("admitsBudgetReserve", () => {
  const reserve = { costUsd: 6, tokens: 100 };
  const empty = {
    spent: { costUsd: 0, tokens: 0 },
    reserved: { costUsd: 0, tokens: 0 },
  };
  test("without a limit only the agent's own work is refused", () => {
    for (const limit of [null, { costUsd: null, tokens: null }]) {
      expect(
        ["user", "key", "none"].map((rootKind) =>
          admitsBudgetReserve({
            rootKind: rootKind as "user" | "key" | "none",
            limit,
            held: null,
            reserve,
          }),
        ),
      ).toEqual([true, true, false]);
    }
  });
  test("with a limit every root kind is held to it", () => {
    const limit = { costUsd: 10, tokens: null };
    const held = { ...empty, reserved: { costUsd: 6, tokens: 100 } };
    for (const rootKind of ["user", "key", "none"] as const) {
      expect(
        admitsBudgetReserve({ rootKind, limit, held: empty, reserve }),
      ).toBe(true);
      expect(admitsBudgetReserve({ rootKind, limit, held, reserve })).toBe(
        false,
      );
    }
  });
  test("a cost sum that reaches the limit exactly is reached, whatever floats say", () => {
    // 0.7 + 0.1 + 0.1 is 0.8999999999999999 in floating point.
    expect(
      admitsBudgetReserve({
        rootKind: "user",
        limit: { costUsd: 0.9, tokens: null },
        held: {
          spent: { costUsd: 0.7, tokens: 0 },
          reserved: { costUsd: 0.1, tokens: 0 },
        },
        reserve: { costUsd: 0.1, tokens: 0 },
      }),
    ).toBe(false);
  });
  test("token sums past 2^53 are exact", () => {
    const limit = { costUsd: null, tokens: Number.MAX_SAFE_INTEGER };
    const held = {
      spent: { costUsd: 0, tokens: Number.MAX_SAFE_INTEGER - 1 },
      reserved: { costUsd: 0, tokens: 0 },
    };
    expect(
      admitsBudgetReserve({
        rootKind: "user",
        limit,
        held,
        reserve: { costUsd: 0, tokens: 1 },
      }),
    ).toBe(false);
  });
  test("spent counts with held, and the token limit alone stops it", () => {
    const held = {
      spent: { costUsd: 0, tokens: 900 },
      reserved: { costUsd: 0, tokens: 0 },
    };
    expect(
      admitsBudgetReserve({
        rootKind: "user",
        limit: { costUsd: null, tokens: 1_000 },
        held,
        reserve,
      }),
    ).toBe(false);
    expect(
      admitsBudgetReserve({
        rootKind: "user",
        limit: { costUsd: null, tokens: 1_001 },
        held,
        reserve,
      }),
    ).toBe(true);
  });
});
