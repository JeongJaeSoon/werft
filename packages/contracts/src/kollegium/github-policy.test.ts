import { describe, expect, test } from "bun:test";

import {
  type AgentGitHub,
  type AgentGitHubSettingsRow,
  agentGitHubSettingsSchema,
  type EffectiveGitHubPolicy,
  effectiveGitHubPolicy,
  GITHUB_POLICY_CLOSED,
  type GitHubPolicyStart,
  githubPolicyStartSchema,
  meetGitHubSettings,
  meetPushAttached,
  newSessionGitHubPolicy,
  pushAttachedOf,
  pushDecisionOf,
} from "./agents.ts";

const PIN: AgentGitHub = {
  repositories: ["app"],
  push_approval: false,
  features: {
    workflows: false,
    actions: true,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [],
};

const ROW: AgentGitHubSettingsRow = {
  repositories: ["infra"],
  pushApproval: true,
  features: { ...PIN.features, actions: false },
  actionsAllow: [{ workflow: "ci.yml" }],
  startRepositoryId: "infra",
  pushAttached: null,
  revision: 4,
  updatedBy: null,
};

const SETTINGS = {
  repositories: ROW.repositories,
  push_approval: ROW.pushApproval,
  features: ROW.features,
  actions_allow: ROW.actionsAllow,
};

const PERSON = "6f1d3a52-0b0e-4d67-9a43-1d6b1d0f2c11";

/** What the resolver returns for a field the case does not care about. */
function policy(
  fields: Omit<Partial<EffectiveGitHubPolicy>, "settings"> & {
    source: EffectiveGitHubPolicy["source"];
    settings: unknown;
  },
): EffectiveGitHubPolicy {
  return {
    startRepositoryId: null,
    agentSettingsRevision: null,
    currentRepositories: null,
    startActionsAllow: null,
    enabledAtStart: true,
    pushAttached: "ask",
    ...fields,
  } as EffectiveGitHubPolicy;
}

const ALL_ON = {
  workflows: true,
  actions: true,
  checks: true,
  issues: true,
  review: true,
};
const ALL_OFF = {
  workflows: false,
  actions: false,
  checks: false,
  issues: false,
  review: false,
};

describe("effectiveGitHubPolicy", () => {
  const cases: Array<
    [string, Parameters<typeof effectiveGitHubPolicy>[0], unknown]
  > = [
    [
      "a release session on a release from before settings has no list",
      { source: "release", releasePin: null, agentRow: null },
      policy({ source: "release", settings: null }),
    ],
    [
      "an absent pin reads as none, as a missing jsonb key does",
      { source: "release", releasePin: undefined, agentRow: null },
      policy({ source: "release", settings: null }),
    ],
    [
      "a release session reads its pin",
      { source: "release", releasePin: PIN, agentRow: null },
      policy({ source: "release", settings: PIN }),
    ],
    [
      "a pin this image cannot read is invalid",
      { source: "release", releasePin: { repositories: [] }, agentRow: null },
      policy({ source: "release", settings: "invalid" }),
    ],
    [
      "an agent session reads the agent's row, not the pin",
      { source: "agent", releasePin: PIN, agentRow: ROW },
      policy({
        source: "agent",
        settings: SETTINGS,
        startRepositoryId: "infra",
        agentSettingsRevision: 4,
      }),
    ],
    [
      "an agent session whose row is gone is closed, not legacy",
      { source: "agent", releasePin: PIN, agentRow: null },
      policy({ source: "agent", settings: GITHUB_POLICY_CLOSED }),
    ],
    [
      "an empty list is legal on the row",
      {
        source: "agent",
        releasePin: null,
        agentRow: { ...ROW, repositories: [], startRepositoryId: null },
      },
      policy({
        source: "agent",
        settings: { ...SETTINGS, repositories: [] },
        agentSettingsRevision: 4,
      }),
    ],
    [
      "a row this image cannot read is invalid",
      {
        source: "agent",
        releasePin: PIN,
        agentRow: { ...ROW, features: { unknown: true } },
      },
      policy({
        source: "agent",
        settings: "invalid",
        agentSettingsRevision: 4,
      }),
    ],
    [
      "a source this image does not know is invalid",
      { source: "team", releasePin: PIN, agentRow: ROW },
      policy({ source: "agent", settings: "invalid" }),
    ],
    [
      "no source at all is invalid, never the release",
      { source: null, releasePin: PIN, agentRow: null },
      policy({ source: "agent", settings: "invalid" }),
    ],
  ];

  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(effectiveGitHubPolicy(input)).toEqual(expected as never);
    });
  }

  test("closed asks a person and allows nothing", () => {
    expect(GITHUB_POLICY_CLOSED.repositories).toEqual([]);
    expect(GITHUB_POLICY_CLOSED.push_approval).toBe(true);
    expect(GITHUB_POLICY_CLOSED.actions_allow).toEqual([]);
    expect(Object.values(GITHUB_POLICY_CLOSED.features)).not.toContain(true);
  });

  test("a list past the old cap of 32 reads", () => {
    const many = Array.from({ length: 40 }, (_, i) => `repo-${i}`);
    expect(
      agentGitHubSettingsSchema.safeParse({ ...SETTINGS, repositories: many })
        .success,
    ).toBe(true);
    const read = effectiveGitHubPolicy({
      source: "agent",
      releasePin: null,
      agentRow: { ...ROW, repositories: many },
    });
    expect(read.settings).toMatchObject({ repositories: many });
  });
});

describe("a release session and a row a person saved", () => {
  const human: AgentGitHubSettingsRow = {
    ...ROW,
    repositories: ["app", "infra"],
    updatedBy: PERSON,
    features: ALL_OFF,
    pushApproval: true,
    actionsAllow: [{ workflow: "ci.yml" }],
  };
  const pin: AgentGitHub = {
    repositories: ["app", "docs"],
    push_approval: false,
    features: { ...ALL_ON, review: false },
    actions_allow: [{ workflow: "deploy.yml" }],
  };

  test("narrows the pin: lists meet, approval ORs, features AND", () => {
    const read = effectiveGitHubPolicy({
      source: "release",
      releasePin: pin,
      agentRow: { ...human, features: { ...ALL_ON, issues: false } },
    });
    expect(read).toEqual(
      policy({
        source: "release",
        settings: {
          repositories: ["app"],
          push_approval: true,
          features: { ...ALL_ON, issues: false, review: false },
          actions_allow: [{ workflow: "ci.yml" }],
        },
        agentSettingsRevision: 4,
        startActionsAllow: [{ workflow: "deploy.yml" }],
      }),
    );
  });

  test("a repository the person added back is not wider than the pin", () => {
    const read = effectiveGitHubPolicy({
      source: "release",
      releasePin: pin,
      agentRow: { ...human, repositories: ["app", "docs", "new-one"] },
    });
    expect(read.settings).toMatchObject({ repositories: ["app", "docs"] });
  });

  test("a pin that waives approval stays waived only if the row waives too", () => {
    const waived = effectiveGitHubPolicy({
      source: "release",
      releasePin: pin,
      agentRow: { ...human, pushApproval: false },
    });
    expect(waived.settings).toMatchObject({ push_approval: false });
    const asked = effectiveGitHubPolicy({
      source: "release",
      releasePin: pin,
      agentRow: human,
    });
    expect(asked.settings).toMatchObject({ push_approval: true });
  });

  test("with no pin the settings stay null and only the list is added", () => {
    const read = effectiveGitHubPolicy({
      source: "release",
      releasePin: undefined,
      agentRow: human,
    });
    expect(read).toEqual(
      policy({
        source: "release",
        settings: null,
        agentSettingsRevision: 4,
        currentRepositories: ["app", "infra"],
      }),
    );
  });

  test("a row a migration wrote (updatedBy null) changes nothing", () => {
    const migrated = { ...human, updatedBy: null };
    expect(
      effectiveGitHubPolicy({
        source: "release",
        releasePin: pin,
        agentRow: migrated,
      }),
    ).toEqual(policy({ source: "release", settings: pin }));
    expect(
      effectiveGitHubPolicy({
        source: "release",
        releasePin: undefined,
        agentRow: migrated,
      }),
    ).toEqual(policy({ source: "release", settings: null }));
  });

  test("no row changes nothing", () => {
    expect(
      effectiveGitHubPolicy({
        source: "release",
        releasePin: pin,
        agentRow: null,
      }),
    ).toEqual(policy({ source: "release", settings: pin }));
  });

  const unreadable: Array<[string, AgentGitHubSettingsRow]> = [
    ["a row that does not parse, saved by a person", { ...human, features: 1 }],
    [
      "a row that does not parse, written by a migration",
      { ...human, features: 1, updatedBy: null },
    ],
    [
      "an updatedBy that is neither a string nor null",
      { ...human, updatedBy: undefined as unknown as string },
    ],
    [
      "an updatedBy that is a number",
      { ...human, updatedBy: 7 as unknown as string },
    ],
  ];
  for (const [name, row] of unreadable) {
    for (const releasePin of [pin, undefined]) {
      test(`${name} closes the session (${releasePin === undefined ? "no pin" : "pin"})`, () => {
        const read = effectiveGitHubPolicy({
          source: "release",
          releasePin,
          agentRow: row,
        });
        expect(read.settings).toBe("invalid");
        expect(read.source).toBe("release");
      });
    }
  }

  test("a pin this image cannot read stays invalid under a person's row", () => {
    expect(
      effectiveGitHubPolicy({
        source: "release",
        releasePin: { repositories: [] },
        agentRow: human,
      }).settings,
    ).toBe("invalid");
  });
});

describe("an agent session with a start snapshot", () => {
  const start: GitHubPolicyStart = {
    enabled: true,
    revision: 2,
    settings: {
      repositories: ["a", "b", "c"],
      push_approval: false,
      features: { ...ALL_ON, review: false },
      actions_allow: [{ workflow: "ci.yml" }],
    },
  };
  const now: AgentGitHubSettingsRow = {
    repositories: ["c", "d", "a"],
    pushApproval: false,
    features: ALL_ON,
    actionsAllow: [{ workflow: "release.yml" }],
    startRepositoryId: null,
    pushAttached: null,
    revision: 5,
    updatedBy: PERSON,
  };

  test("meets the start and the row now", () => {
    expect(
      effectiveGitHubPolicy({
        source: "agent",
        releasePin: null,
        agentRow: now,
        start,
      }),
    ).toEqual(
      policy({
        source: "agent",
        settings: {
          repositories: ["a", "c"],
          push_approval: false,
          features: { ...ALL_ON, review: false },
          actions_allow: [{ workflow: "release.yml" }],
        },
        agentSettingsRevision: 5,
        startActionsAllow: [{ workflow: "ci.yml" }],
      }),
    );
  });

  test("a repository added after the start does not open", () => {
    const read = effectiveGitHubPolicy({
      source: "agent",
      releasePin: null,
      agentRow: { ...now, repositories: ["a", "b", "c", "new"] },
      start,
    });
    expect(read.settings).toMatchObject({ repositories: ["a", "b", "c"] });
  });

  test("a repository taken off closes at once", () => {
    const read = effectiveGitHubPolicy({
      source: "agent",
      releasePin: null,
      agentRow: { ...now, repositories: ["a"] },
      start,
    });
    expect(read.settings).toMatchObject({ repositories: ["a"] });
  });

  test("a feature or an approval turned on later does not widen", () => {
    const read = effectiveGitHubPolicy({
      source: "agent",
      releasePin: null,
      agentRow: { ...now, features: ALL_ON, pushApproval: true },
      start,
    });
    expect(read.settings).toMatchObject({
      push_approval: true,
      features: { review: false },
    });
  });

  test("GitHub off at the start stays off for the session", () => {
    const read = effectiveGitHubPolicy({
      source: "agent",
      releasePin: null,
      agentRow: now,
      start: { ...start, enabled: false },
    });
    expect(read.enabledAtStart).toBe(false);
  });

  test("a snapshot this image cannot read is invalid", () => {
    for (const unreadable of [{}, { enabled: true }, "x", 3]) {
      expect(
        effectiveGitHubPolicy({
          source: "agent",
          releasePin: null,
          agentRow: now,
          start: unreadable,
        }).settings,
      ).toBe("invalid");
    }
  });

  test("a row that is gone is closed whatever the snapshot says", () => {
    expect(
      effectiveGitHubPolicy({
        source: "agent",
        releasePin: null,
        agentRow: null,
        start,
      }).settings,
    ).toEqual(GITHUB_POLICY_CLOSED);
  });

  test("a session with no snapshot reads the row alone", () => {
    expect(
      effectiveGitHubPolicy({
        source: "agent",
        releasePin: null,
        agentRow: now,
        start: null,
      }).settings,
    ).toMatchObject({ repositories: ["c", "d", "a"] });
  });
});

describe("meetGitHubSettings", () => {
  const left: AgentGitHub = {
    repositories: ["a", "b"],
    push_approval: false,
    features: ALL_ON,
    actions_allow: [],
  };

  test("never gives more than either side", () => {
    const right: AgentGitHub = {
      repositories: ["b", "c"],
      push_approval: true,
      features: { ...ALL_OFF, checks: true },
      actions_allow: [{ workflow: "x.yml" }],
    };
    for (const [a, b] of [
      [left, right],
      [right, left],
    ] as const) {
      const met = meetGitHubSettings(a, b);
      expect(met.repositories).toEqual(["b"]);
      expect(met.push_approval).toBe(true);
      expect(met.features).toEqual({ ...ALL_OFF, checks: true });
    }
  });
});

describe("push_attached: a push to an attached repository", () => {
  const person = { ...ROW, updatedBy: PERSON };
  const START: GitHubPolicyStart = {
    enabled: true,
    revision: 2,
    settings: PIN,
  };

  test("a value is read as it is stored; none reads as ask; an unknown one is refused", () => {
    expect(pushAttachedOf("allow")).toBe("allow");
    expect(pushAttachedOf("ask")).toBe("ask");
    expect(pushAttachedOf("deny")).toBe("deny");
    // A row from before the column keeps asking a person.
    expect(pushAttachedOf(null)).toBe("ask");
    expect(pushAttachedOf(undefined)).toBe("ask");
    // A value a later image wrote must not widen anything here.
    expect(pushAttachedOf("ask_once")).toBe("deny");
  });

  test("the stricter side wins: deny > ask > allow", () => {
    const values = ["allow", "ask", "deny"] as const;
    const rank = { allow: 0, ask: 1, deny: 2 };
    for (const a of values) {
      for (const b of values) {
        expect(meetPushAttached(a, b)).toBe(rank[a] >= rank[b] ? a : b);
        expect(meetPushAttached(a, b)).toBe(meetPushAttached(b, a));
      }
    }
  });

  test("an agent session with no snapshot began as ask, so a later allow does not widen it", () => {
    const read = (pushAttached: string | null) =>
      effectiveGitHubPolicy({
        source: "agent",
        releasePin: undefined,
        agentRow: { ...person, pushAttached },
      }).pushAttached;
    expect(read("allow")).toBe("ask");
    expect(read("deny")).toBe("deny");
    expect(read(null)).toBe("ask");
  });

  test("a snapshot only narrows: allow at start and ask now is ask; ask at start and allow now is ask", () => {
    const read = (atStart: "allow" | "ask" | "deny" | undefined, now: string) =>
      effectiveGitHubPolicy({
        source: "agent",
        releasePin: undefined,
        agentRow: { ...person, pushAttached: now },
        start: {
          ...START,
          ...(atStart === undefined ? {} : { push_attached: atStart }),
        },
      }).pushAttached;
    expect(read("allow", "allow")).toBe("allow");
    expect(read("allow", "ask")).toBe("ask");
    expect(read("allow", "deny")).toBe("deny");
    expect(read("ask", "allow")).toBe("ask");
    expect(read("deny", "allow")).toBe("deny");
    // A snapshot from before the value was kept reads as ask.
    expect(read(undefined, "allow")).toBe("ask");
  });

  test("a snapshot that carries the value still parses for an image that does not know it", () => {
    // The envelope is not strict: an older schema ignores the extra key.
    const older = githubPolicyStartSchema.omit({ push_attached: true });
    expect(older.safeParse({ ...START, push_attached: "allow" }).success).toBe(
      true,
    );
    expect(githubPolicyStartSchema.safeParse(START).success).toBe(true);
  });

  test("a release session means ask: a person's row can take it to deny, never to allow", () => {
    const read = (pushAttached: string | null, updatedBy: string | null) =>
      effectiveGitHubPolicy({
        source: "release",
        releasePin: PIN,
        agentRow: { ...ROW, pushAttached, updatedBy },
      }).pushAttached;
    expect(read("allow", PERSON)).toBe("ask");
    expect(read("deny", PERSON)).toBe("deny");
    // A row a migration wrote changes nothing for a session on its release.
    expect(read("deny", null)).toBe("ask");
    expect(
      effectiveGitHubPolicy({
        source: "release",
        releasePin: PIN,
        agentRow: null,
      }).pushAttached,
    ).toBe("ask");
    expect(newSessionGitHubPolicy(null, PIN).pushAttached).toBe("ask");
  });

  test("a policy that cannot be read does not widen the value", () => {
    const read = effectiveGitHubPolicy({
      source: "agent",
      releasePin: undefined,
      agentRow: {
        ...person,
        repositories: "a later shape",
        pushAttached: "allow",
      },
    });
    expect(read.settings).toBe("invalid");
    expect(read.pushAttached).toBe("ask");
  });
});

describe("newSessionGitHubPolicy", () => {
  test("no row keeps today's answer: the release", () => {
    expect(newSessionGitHubPolicy(null, PIN).source).toBe("release");
    expect(newSessionGitHubPolicy(null, PIN).settings).toEqual(PIN);
    expect(newSessionGitHubPolicy(null, undefined).settings).toBeNull();
  });

  test("a new session starts at the row's own push_attached, not at the cap of a session with no snapshot", () => {
    const start = (pushAttached: string | null) =>
      newSessionGitHubPolicy({ ...ROW, pushAttached }, PIN).pushAttached;
    expect(start("allow")).toBe("allow");
    expect(start("deny")).toBe("deny");
    expect(start(null)).toBe("ask");
  });

  test("a row makes the session the agent's", () => {
    const read = newSessionGitHubPolicy(ROW, PIN);
    expect(read.source).toBe("agent");
    expect(read.startRepositoryId).toBe("infra");
  });
});

describe("pushDecisionOf: one rule for every repository", () => {
  type Decision = "allow" | "ask" | "deny";
  const TABLE: Array<[boolean, Decision, Decision]> = [
    [true, "allow", "allow"],
    [true, "ask", "ask"],
    [true, "deny", "deny"],
    [false, "allow", "ask"],
    [false, "ask", "ask"],
    [false, "deny", "deny"],
  ];

  for (const [off, attached, expected] of TABLE) {
    test(`push_approval ${off ? "false" : "true"} × push_attached ${attached}`, () => {
      const policy = {
        settings: { ...PIN, push_approval: !off },
        pushAttached: attached,
      };
      expect(pushDecisionOf(policy)).toBe(expected);
    });
  }

  test("settings that cannot be applied ask, and deny still denies", () => {
    for (const settings of ["invalid", null] as const) {
      expect(pushDecisionOf({ settings, pushAttached: "allow" })).toBe("ask");
      expect(pushDecisionOf({ settings, pushAttached: "deny" })).toBe("deny");
    }
  });

  test("a snapshot that started open and is narrowed meets to the stricter value", () => {
    const row = { ...ROW, pushApproval: false, updatedBy: PERSON };
    const start: GitHubPolicyStart = {
      enabled: true,
      revision: 2,
      settings: { ...PIN, push_approval: false },
      push_attached: "allow",
    };
    const asked = effectiveGitHubPolicy({
      source: "agent",
      releasePin: null,
      agentRow: { ...row, pushApproval: true, pushAttached: "allow" },
      start,
    });
    expect(pushDecisionOf(asked)).toBe("ask");
    const denied = effectiveGitHubPolicy({
      source: "agent",
      releasePin: null,
      agentRow: { ...row, pushAttached: "deny" },
      start,
    });
    expect(pushDecisionOf(denied)).toBe("deny");
  });
});
