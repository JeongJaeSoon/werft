import { describe, expect, test } from "bun:test";
import type { CallerLimitRuleFacts } from "../ports/agent-caller-limits-store.ts";
import {
  type CallerLimit,
  callerLimitDigest,
  callerLimitRefusal,
  mergeCallerLimit,
  narrowReach,
  type SessionReach,
  withLiveRepositories,
} from "./caller-limit.ts";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const rule = (
  target: CallerLimitRuleFacts["target"],
  patch: Partial<Omit<CallerLimitRuleFacts, "target">> = {},
): CallerLimitRuleFacts => ({
  target,
  tools_deny: [],
  repositories: null,
  mcp_servers: null,
  credentials_deny: [],
  ...patch,
});

const nobody = { teamIds: [], channelId: null };

describe("mergeCallerLimit", () => {
  test("no rule reaching the subject is no limit", () => {
    expect(
      mergeCallerLimit([rule({ kind: "team", id: T1 })], nobody, 3),
    ).toBeNull();
    expect(mergeCallerLimit([], nobody, 3)).toBeNull();
  });

  test("denials unite, allowances intersect, null takes no part", () => {
    const merged = mergeCallerLimit(
      [
        rule(
          { kind: "workspace" },
          {
            tools_deny: ["Bash", "Write"],
            repositories: ["a", "b", "c"],
            credentials_deny: ["x"],
          },
        ),
        rule(
          { kind: "team", id: T1 },
          {
            tools_deny: ["Write", "Edit"],
            repositories: ["b", "c", "d"],
            mcp_servers: ["github"],
            credentials_deny: ["y"],
          },
        ),
        rule({ kind: "channel", id: "C1" }, { repositories: null }),
      ],
      { teamIds: [T1], channelId: "c1" },
      4,
    );
    expect(merged).toEqual({
      v: 1,
      tools_deny: ["Bash", "Edit", "Write"],
      repositories: ["b", "c"],
      mcp_servers: ["github"],
      credentials_deny: ["x", "y"],
      revision: 4,
    });
  });

  test("an empty allowance stays empty, a disjoint pair becomes empty", () => {
    const merged = mergeCallerLimit(
      [
        rule({ kind: "workspace" }, { repositories: ["a"], mcp_servers: [] }),
        rule({ kind: "team", id: T1 }, { repositories: ["b"] }),
      ],
      { teamIds: [T1], channelId: null },
      1,
    );
    expect(merged?.repositories).toEqual([]);
    expect(merged?.mcp_servers).toEqual([]);
  });

  test("a team the subject is not in, another channel and a user rule are skipped", () => {
    const merged = mergeCallerLimit(
      [
        rule({ kind: "workspace" }, { tools_deny: ["a"] }),
        rule({ kind: "team", id: T2 }, { tools_deny: ["b"] }),
        rule({ kind: "channel", id: "C2" }, { tools_deny: ["c"] }),
        rule({ kind: "user", id: T1 }, { tools_deny: ["d"] }),
      ],
      { teamIds: [T1], channelId: "C1" },
      1,
    );
    expect(merged?.tools_deny).toEqual(["a"]);
  });

  test("team ids and channel ids compare lowercase", () => {
    const merged = mergeCallerLimit(
      [
        rule({ kind: "team", id: T1.toUpperCase() }, { tools_deny: ["t"] }),
        rule({ kind: "channel", id: "C0ABC" }, { tools_deny: ["c"] }),
      ],
      { teamIds: [T1], channelId: "c0abc" },
      1,
    );
    expect(merged?.tools_deny).toEqual(["c", "t"]);
  });

  test("a channel rule needs a channel", () => {
    expect(
      mergeCallerLimit([rule({ kind: "channel", id: "C1" })], nobody, 1),
    ).toBeNull();
  });
});

describe("withLiveRepositories", () => {
  test("drops ids the catalog lost, keeps null", () => {
    const rules = withLiveRepositories(
      [
        rule({ kind: "workspace" }, { repositories: ["a", "gone"] }),
        rule({ kind: "team", id: T1 }, { repositories: ["gone"] }),
        rule({ kind: "channel", id: "C1" }),
      ],
      (id) => id === "a",
    );
    expect(rules.map((r) => r.repositories)).toEqual([["a"], [], null]);
  });
});

describe("callerLimitDigest", () => {
  const limit: CallerLimit = {
    v: 1,
    tools_deny: ["Bash"],
    repositories: ["a"],
    mcp_servers: null,
    credentials_deny: [],
    revision: 1,
  };

  test("is stable and ignores the revision", () => {
    expect(callerLimitDigest(limit)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(callerLimitDigest({ ...limit, revision: 9 })).toBe(
      callerLimitDigest(limit),
    );
  });

  test("changes with any limit field, and tells null from empty", () => {
    const base = callerLimitDigest(limit);
    for (const changed of [
      { tools_deny: [] },
      { repositories: [] },
      { repositories: null },
      { mcp_servers: [] },
      { credentials_deny: ["k"] },
    ]) {
      expect(callerLimitDigest({ ...limit, ...changed })).not.toBe(base);
    }
  });
});

describe("callerLimitRefusal", () => {
  const reach: SessionReach = {
    tools: ["Bash", "Read"],
    repositories: ["a"],
    mcp_servers: ["github"],
    credentials: ["slack"],
  };
  const limit = (patch: Partial<CallerLimit>): CallerLimit => ({
    v: 1,
    tools_deny: [],
    repositories: null,
    mcp_servers: null,
    credentials_deny: [],
    revision: 1,
    ...patch,
  });

  test.each([
    ["no limit", null, null],
    ["an open limit", limit({}), null],
    ["a tool the session loads", limit({ tools_deny: ["Bash"] }), "tool"],
    ["a tool the session does not load", limit({ tools_deny: ["Edit"] }), null],
    ["a repository outside", limit({ repositories: ["b"] }), "repository"],
    ["no repository allowed", limit({ repositories: [] }), "repository"],
    ["the repository allowed", limit({ repositories: ["a", "b"] }), null],
    ["an mcp server outside", limit({ mcp_servers: [] }), "mcp_server"],
    ["the mcp server allowed", limit({ mcp_servers: ["github"] }), null],
    [
      "a credential denied",
      limit({ credentials_deny: ["slack"] }),
      "credential",
    ],
    ["another credential denied", limit({ credentials_deny: ["x"] }), null],
  ] as const)("%s", (_name, given, dimension) => {
    expect(callerLimitRefusal(given, reach)).toBe(dimension);
  });

  test("a session with nothing of a kind is covered whatever the limit says", () => {
    const bare = {
      tools: [],
      repositories: [],
      mcp_servers: [],
      credentials: [],
    };
    expect(
      callerLimitRefusal(
        limit({ repositories: [], mcp_servers: [], tools_deny: ["Bash"] }),
        bare,
      ),
    ).toBeNull();
  });
});

describe("narrowReach", () => {
  const reach: SessionReach = {
    tools: ["Bash", "Read"],
    repositories: ["a", "b"],
    mcp_servers: ["github"],
    credentials: ["slack", "jira"],
  };

  test("a session without a pinned limit keeps all it loads", () => {
    expect(narrowReach(reach, null)).toBe(reach);
  });

  test("what the pinned limit took away is not asked of a later sender", () => {
    const pinned: CallerLimit = {
      v: 1,
      tools_deny: ["Bash"],
      repositories: ["a"],
      mcp_servers: [],
      credentials_deny: ["slack"],
      revision: 1,
    };
    expect(narrowReach(reach, pinned)).toEqual({
      tools: ["Read"],
      repositories: ["a"],
      mcp_servers: [],
      credentials: ["jira"],
    });
  });
});
