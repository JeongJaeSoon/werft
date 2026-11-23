import { describe, expect, test } from "bun:test";
import {
  admitsBudgetReserve,
  assertBudgetAmount,
  type BudgetChoice,
  type BudgetRoot,
  budgetRootOfTurn,
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
      "an allowed Slack bot: the agent's team, kept as slack_bot",
      { kind: "slack_bot" },
      TEAM,
      { rootKind: "slack_bot", owner: { kind: "team", teamId: TEAM } },
    ],
    [
      "a Slack bot of an agent with no team: no account",
      { kind: "slack_bot" },
      null,
      { rootKind: "slack_bot", owner: null },
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

describe("budgetRootOfTurn", () => {
  const WEB = { method: "web_session", web_session_id: PERSON };
  // The stored requester columns and credential, and the root they give.
  const cases: [
    string,
    {
      requesterKind: string | null;
      requesterId: string | null;
      requesterAuth: unknown;
    },
    BudgetRoot | null,
  ][] = [
    [
      "a person in the console",
      { requesterKind: "user", requesterId: PERSON, requesterAuth: WEB },
      { kind: "user", userId: PERSON },
    ],
    [
      "a linked Slack account is the person",
      {
        requesterKind: "user",
        requesterId: PERSON,
        requesterAuth: { method: "slack_link" },
      },
      { kind: "user", userId: PERSON },
    ],
    [
      "a continuation carries the person in its own columns",
      {
        requesterKind: "user",
        requesterId: PERSON,
        requesterAuth: {
          ...WEB,
          carried_from: { turn: "2", reason: "continuation" },
        },
      },
      { kind: "user", userId: PERSON },
    ],
    [
      "an old turn with no credential recorded is still the person's",
      { requesterKind: "user", requesterId: PERSON, requesterAuth: null },
      { kind: "user", userId: PERSON },
    ],
    [
      "a personal key: a key, made by the person it names",
      {
        requesterKind: "user",
        requesterId: MAKER,
        requesterAuth: { method: "personal_key", api_key_id: TEAM },
      },
      { kind: "key", keyKind: "personal", createdByUserId: MAKER },
    ],
    [
      "an agent key",
      {
        requesterKind: "api_key",
        requesterId: TEAM,
        requesterAuth: { method: "agent_key", agent_id: "agent-1" },
      },
      { kind: "key", keyKind: "agent", createdByUserId: null },
    ],
    [
      "a key no person and no agent holds",
      {
        requesterKind: "api_key",
        requesterId: TEAM,
        requesterAuth: { method: "service_key" },
      },
      { kind: "key", keyKind: "operator", createdByUserId: null },
    ],
    [
      "an allowed Slack bot",
      {
        requesterKind: "slack_bot",
        requesterId: "U0BOT",
        requesterAuth: { method: "slack_bot" },
      },
      { kind: "slack_bot" },
    ],
    [
      "a push follow-up: the root of the push request, not the agent",
      {
        requesterKind: "agent",
        requesterId: "agent-1",
        requesterAuth: {
          method: "push_decision",
          root: {
            requester_kind: "user",
            requester_id: PERSON,
            requester_auth: WEB,
            via: [],
          },
        },
      },
      { kind: "user", userId: PERSON },
    ],
    [
      "a push follow-up of a personal key's push",
      {
        requesterKind: "agent",
        requesterId: "agent-1",
        requesterAuth: {
          method: "push_decision",
          root: {
            requester_kind: "user",
            requester_id: MAKER,
            requester_auth: { method: "personal_key" },
            via: [],
          },
        },
      },
      { kind: "key", keyKind: "personal", createdByUserId: MAKER },
    ],
    [
      "the agent's own turn with no push behind it",
      { requesterKind: "agent", requesterId: "agent-1", requesterAuth: null },
      { kind: "none" },
    ],
    [
      "a push follow-up whose push turn was not found: unreadable",
      {
        requesterKind: "agent",
        requesterId: "agent-1",
        requesterAuth: { method: "push_decision" },
      },
      null,
    ],
    [
      "a root that is itself a push decision: unreadable",
      {
        requesterKind: "agent",
        requesterId: "agent-1",
        requesterAuth: {
          method: "push_decision",
          root: {
            requester_kind: "agent",
            requester_id: "agent-1",
            requester_auth: { method: "push_decision" },
            via: [],
          },
        },
      },
      null,
    ],
    [
      "no requester recorded",
      { requesterKind: null, requesterId: null, requesterAuth: null },
      null,
    ],
    [
      "a kind this build does not know",
      { requesterKind: "robot", requesterId: "r-1", requesterAuth: null },
      null,
    ],
    [
      "a person whose id is not a user id",
      { requesterKind: "user", requesterId: "not-a-uuid", requesterAuth: WEB },
      null,
    ],
  ];
  for (const [name, turn, expected] of cases) {
    test(name, () => {
      expect(budgetRootOfTurn(turn)).toEqual(expected);
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
        (["user", "key", "slack_bot", "none"] as const).map((rootKind) =>
          admitsBudgetReserve({ rootKind, limit, held: null, reserve }),
        ),
      ).toEqual([true, true, true, false]);
    }
  });
  test("with a limit every root kind is held to it", () => {
    const limit = { costUsd: 10, tokens: null };
    const held = { ...empty, reserved: { costUsd: 6, tokens: 100 } };
    for (const rootKind of ["user", "key", "slack_bot", "none"] as const) {
      expect(
        admitsBudgetReserve({ rootKind, limit, held: empty, reserve }),
      ).toBe(true);
      expect(admitsBudgetReserve({ rootKind, limit, held, reserve })).toBe(
        false,
      );
    }
  });
  // Decision 31 at 80% and 100%: an account at each use, then a reserve of
  // 0.5% of its limit. Before, every root kind ran to 100%; now root kind
  // none stops at 80%, and slack_bot runs to 100% as a key does.
  describe("the 80% and 100% marks", () => {
    const roots = ["user", "key", "slack_bot", "none"] as const;
    // use (%) → admitted, for each of roots in order. Before, the none
    // column read as the others: true, true, true, false.
    const table: [number, boolean[]][] = [
      [79, [true, true, true, true]],
      [80, [true, true, true, false]],
      [99, [true, true, true, false]],
      [100, [false, false, false, false]],
    ];
    const cases = [
      ["cost", { costUsd: 200, tokens: null }],
      ["tokens", { costUsd: null, tokens: 200_000 }],
    ] as const;
    for (const [unit, limit] of cases) {
      for (const [use, after] of table) {
        test(`${unit} limit, ${use}% used`, () => {
          const share = (percent: number) => ({
            costUsd: ((limit.costUsd ?? 0) * percent) / 100,
            tokens: ((limit.tokens ?? 0) * percent) / 100,
          });
          expect(
            roots.map((rootKind) =>
              admitsBudgetReserve({
                rootKind,
                limit,
                held: {
                  spent: share(use - 10),
                  reserved: share(10),
                },
                reserve: share(0.5),
              }),
            ),
          ).toEqual(after);
        });
      }
    }
    test("without a limit there is no 80% mark", () => {
      const held = {
        spent: { costUsd: 1_000_000, tokens: 1_000_000 },
        reserved: { costUsd: 0, tokens: 0 },
      };
      for (const limit of [null, { costUsd: null, tokens: null }]) {
        expect(
          roots.map((rootKind) =>
            admitsBudgetReserve({
              rootKind,
              limit,
              held,
              reserve: { costUsd: 1, tokens: 1 },
            }),
          ),
        ).toEqual([true, true, true, false]);
      }
    });
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
