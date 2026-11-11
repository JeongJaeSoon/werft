import { describe, expect, test } from "bun:test";
import { GITHUB_FEATURES_NONE } from "@werft-ai/contracts";
import { githubPolicyOfRow } from "../github-settings.ts";

// The session row's own attached list reaches the policy through this one
// function, so a caller that drops it silently brings the old intersection
// back. The DB integration tests prove it end to end; this one fails without
// a database.
const row = (attachedRepositoryIds: string[] | null) => ({
  githubPolicySource: "agent",
  githubPolicyStart: {
    enabled: true,
    revision: 1,
    settings: {
      repositories: ["a"],
      push_approval: false,
      features: GITHUB_FEATURES_NONE,
      actions_allow: [],
    },
    push_attached: "allow",
  },
  attachedRepositoryIds,
  releasePin: null,
  settingsRepositories: ["a", "new"],
  settingsPushApproval: false,
  settingsFeatures: GITHUB_FEATURES_NONE,
  settingsActionsAllow: [],
  settingsStartRepositoryId: null,
  settingsPushAttached: "allow",
  settingsRevision: 2,
  settingsUpdatedBy: null,
});

describe("githubPolicyOfRow", () => {
  test("a session with its own list reads the repositories saved now", () => {
    for (const list of [[], ["a"]]) {
      expect(githubPolicyOfRow(row(list)).settings).toMatchObject({
        repositories: ["a", "new"],
      });
    }
  });

  test("a session without one keeps what it started with", () => {
    expect(githubPolicyOfRow(row(null)).settings).toMatchObject({
      repositories: ["a"],
    });
  });
});
