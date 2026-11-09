import { describe, expect, test } from "bun:test";
import type {
  ClaimedRolloutItem,
  ProfileRolloutStore,
  RolloutInspection,
  RolloutItemResult,
} from "../ports/profile-rollout-store.ts";
import { judgeProfileRollout } from "../sessions/profile-rollout-policy.ts";
import { createProfileRolloutRunner } from "./profile-rollout-runner.ts";

const quiet = { info: () => {}, warn: () => {} };

const item = (n: number): ClaimedRolloutItem => ({
  rolloutId: "r1",
  agentId: `agent-${n}`,
  generation: 0,
  claim: "claim-1",
  workspaceId: "w1",
  targetProfileId: "op_x_v2",
  actorUserId: "u1",
});

const profile = (version: number, tools: string[]) => ({
  id: `op_x_v${version}`,
  version,
  definition: { model: "m", tools },
  deny: null,
});

const following: RolloutInspection = {
  tracking: "follow",
  sameLineage: true,
  latest: profile(2, ["Read", "Write"]),
  active: profile(1, ["Read"]),
};

const decisions: {
  name: string;
  change: Partial<RolloutInspection>;
  expected: ReturnType<typeof judgeProfileRollout>;
}[] = [
  {
    name: "a changed older form follows the latest",
    change: {},
    expected: { status: "release", profileId: "op_x_v2" },
  },
  {
    name: "a pinned agent stays pinned",
    change: { tracking: "pinned" },
    expected: { status: "superseded" },
  },
  {
    name: "pinned wins over an already current form",
    change: { tracking: "pinned", active: profile(2, ["Read", "Write"]) },
    expected: { status: "superseded" },
  },
  {
    name: "an absent agent has no tracking",
    change: { tracking: null },
    expected: { status: "superseded" },
  },
  {
    name: "a different lineage is superseded",
    change: { sameLineage: false },
    expected: { status: "superseded" },
  },
  {
    name: "a different lineage wins over an already current version",
    change: { sameLineage: false, active: profile(2, ["Read"]) },
    expected: { status: "superseded" },
  },
  {
    name: "a missing latest is superseded",
    change: { latest: null },
    expected: { status: "superseded" },
  },
  {
    name: "a missing active profile is superseded",
    change: { active: null },
    expected: { status: "superseded" },
  },
  {
    name: "the current version is applied even if its form differs",
    change: { active: profile(2, ["Read"]) },
    expected: { status: "applied" },
  },
  {
    name: "a newer active version is applied",
    change: { active: profile(3, ["Read"]) },
    expected: { status: "applied" },
  },
  {
    name: "an older version with the same form is applied",
    change: { latest: profile(2, ["Read"]) },
    expected: { status: "applied" },
  },
  {
    name: "tool order does not require another release",
    change: {
      latest: profile(2, ["Write", "Read"]),
      active: profile(1, ["Read", "Write"]),
    },
    expected: { status: "applied" },
  },
  {
    name: "a changed MCP deny requires a release",
    change: { latest: { ...profile(2, ["Read"]), deny: ["mcp__docs__read"] } },
    expected: { status: "release", profileId: "op_x_v2" },
  },
];

describe("profile rollout decisions", () => {
  test.each(decisions)("$name", ({ change, expected }) => {
    expect(judgeProfileRollout({ ...following, ...change })).toEqual(expected);
  });

  test("a pin short circuits before the active profile or execution form is read", () => {
    expect(
      judgeProfileRollout({
        ...following,
        tracking: "pinned",
        get active(): RolloutInspection["active"] {
          throw new Error("must not read active");
        },
      }),
    ).toEqual({ status: "superseded" });
  });

  test("version ordering short circuits before execution forms are read", () => {
    const current = {
      ...profile(2, ["Read"]),
      get definition(): Record<string, unknown> {
        throw new Error("must not read definition");
      },
    };
    expect(judgeProfileRollout({ ...following, active: current })).toEqual({
      status: "applied",
    });
  });
});

describe("the rollout runner", () => {
  test.each(decisions)(
    "wires $name through inspection and settlement",
    async ({ change, expected }) => {
      const calls: string[] = [];
      const settled: RolloutItemResult[] = [];
      const runner = createProfileRolloutRunner({
        rollouts: {
          async claim() {
            calls.push("claim");
            return [item(1)];
          },
          async inspect() {
            calls.push("inspect");
            return { ...following, ...change };
          },
          async settle(_held: ClaimedRolloutItem, result: RolloutItemResult) {
            calls.push("settle");
            settled.push(result);
            return true;
          },
        } as unknown as ProfileRolloutStore,
        agentStore: {
          async get() {
            calls.push("get");
            return {
              active_release: { runtime_profile_id: "op_x_v1" },
            } as never;
          },
        },
        agents: {
          async rolloutRelease(input) {
            calls.push(`release:${input.targetProfileId}`);
            return { status: "applied" };
          },
        },
        logger: quiet,
      });
      expect(await runner.runOnce()).toEqual({ claimed: 1, settled: 1 });
      expect(calls).toEqual(
        expected.status === "release"
          ? ["claim", "get", "inspect", "release:op_x_v2", "settle"]
          : ["claim", "get", "inspect", "settle"],
      );
      expect(settled).toEqual(
        expected.status === "superseded"
          ? [{ status: "superseded" }]
          : [{ status: "applied" }],
      );
    },
  );

  test("a stop during an item gives the rest of the claim back and ends", async () => {
    const abandoned: string[][] = [];
    const settled: [string, RolloutItemResult][] = [];
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      started = resolve;
    });
    let claims = 0;
    const rollouts = {
      async claim() {
        return claims++ === 0 ? [item(1), item(2), item(3)] : [];
      },
      async settle(held: ClaimedRolloutItem, result: RolloutItemResult) {
        settled.push([held.agentId, result]);
        return true;
      },
      async abandon(given: readonly ClaimedRolloutItem[]) {
        abandoned.push(given.map((held) => held.agentId));
        return given.length;
      },
      async inspect() {
        return {
          tracking: "follow" as const,
          sameLineage: true,
          latest: profile(2, ["Read", "Write"]),
          active: profile(1, ["Read"]),
        };
      },
      async sweep() {
        throw new Error("the sweep is off");
      },
    } as unknown as ProfileRolloutStore;
    const runner = createProfileRolloutRunner({
      rollouts,
      agentStore: {
        async get() {
          return { active_release: { runtime_profile_id: "op_x_v1" } } as never;
        },
      },
      agents: {
        async rolloutRelease() {
          started();
          await inFlight;
          return { status: "applied" };
        },
      },
      logger: quiet,
    });

    const running = runner.start(1);
    await first;
    const stopping = running.stop();
    release();
    await stopping;

    expect(settled.map(([agent]) => agent)).toEqual(["agent-1"]);
    expect(abandoned).toEqual([["agent-2", "agent-3"]]);
  });

  test("the sweep runs only when asked to", async () => {
    let swept = 0;
    const rollouts = {
      async claim() {
        return [];
      },
      async sweep() {
        swept++;
        return { rollouts: 0, items: 0 };
      },
    } as unknown as ProfileRolloutStore;
    const base = {
      rollouts,
      agentStore: { get: async () => null },
      agents: { rolloutRelease: async () => ({ status: "applied" as const }) },
      logger: quiet,
    };
    await createProfileRolloutRunner(base).runOnce();
    expect(swept).toBe(0);
    await createProfileRolloutRunner({ ...base, sweep: true }).runOnce();
    expect(swept).toBe(1);
  });

  test("a sweep held back for the one-time fill warns once per hold, and again after it clears and returns", async () => {
    const answers = [3, 3, 0, 2];
    const warnings: unknown[] = [];
    const rollouts = {
      async claim() {
        return [];
      },
      async sweep() {
        return { rollouts: 0, items: 0, held: answers.shift() ?? 0 };
      },
    } as unknown as ProfileRolloutStore;
    const runner = createProfileRolloutRunner({
      rollouts,
      agentStore: { get: async () => null },
      agents: { rolloutRelease: async () => ({ status: "applied" as const }) },
      logger: {
        info: () => {},
        warn: (_message, fields) => warnings.push(fields),
      },
      sweep: true,
    });
    for (let pass = 0; pass < 4; pass++) await runner.runOnce();
    expect(warnings).toEqual([{ agents: 3 }, { agents: 2 }]);
  });
});
