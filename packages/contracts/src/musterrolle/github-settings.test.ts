import { describe, expect, test } from "bun:test";
import { agentGitHubSchema } from "../kollegium/agents.ts";
import {
  GITHUB_CEILING_DEFAULT,
  GITHUB_CEILING_NONE,
  GITHUB_FEATURES_DEFAULT,
  GITHUB_FEATURES_NONE,
  githubCeilingSchema,
  githubEffectiveFeatures,
  githubFeaturesSchema,
  githubPermissionsFor,
  githubRefusalStatus,
  pullRequestTemplateNameSchema,
} from "./github-settings.ts";

describe("the two workflow switches (94S-2406)", () => {
  test("a new workspace and a new agent start with workflow edits on and direct runs off", () => {
    expect(GITHUB_FEATURES_DEFAULT).toEqual({
      ...GITHUB_FEATURES_NONE,
      workflows: true,
      checks: true,
    });
    expect(GITHUB_CEILING_DEFAULT).toEqual({
      ...GITHUB_FEATURES_DEFAULT,
      merge: false,
    });
  });

  test("reading CI is the workflow-edit switch's; only dispatch and rerun ask actions:write", () => {
    const on = { workflows: true };
    expect(githubPermissionsFor("actions_read", on)).toMatchObject({
      feature: "workflows",
      permissions: { actions: "read", checks: "read" },
    });
    expect(githubPermissionsFor("push", on).permissions).toEqual({
      contents: "write",
      workflows: "write",
    });
    for (const purpose of ["dispatch", "rerun"] as const) {
      expect(githubPermissionsFor(purpose, on)).toMatchObject({
        feature: "actions",
        permissions: { actions: "write" },
      });
    }
    const asksActionsWrite = (
      ["clone", "push", "pull_request", "actions_read"] as const
    ).filter(
      (purpose) =>
        githubPermissionsFor(purpose, on).permissions.actions === "write",
    );
    expect(asksActionsWrite).toEqual([]);
  });

  test("the ceiling turns a switch off whatever the agent holds", () => {
    const agent = { ...GITHUB_FEATURES_DEFAULT, actions: true };
    expect(
      githubEffectiveFeatures(agent, {
        ...GITHUB_CEILING_DEFAULT,
        workflows: false,
      }),
    ).toMatchObject({ workflows: false, actions: false });
    expect(
      githubEffectiveFeatures(agent, GITHUB_CEILING_DEFAULT),
    ).toMatchObject({ workflows: true, actions: false });
  });

  test("the stored shape is the one before the switches: old rows read, and a new row reads under the same strict schema", () => {
    // A row from before, with the old Actions switch on and workflows off.
    const old = {
      workflows: false,
      actions: true,
      checks: false,
      issues: false,
      review: false,
    };
    expect(githubFeaturesSchema.parse(old)).toEqual(old);
    // What the console writes now: checks beside workflows, no new key, so an
    // image before the switches (strict, five keys) reads it as well.
    expect(githubFeaturesSchema.parse(GITHUB_FEATURES_DEFAULT)).toEqual(
      GITHUB_FEATURES_DEFAULT,
    );
    expect(Object.keys(GITHUB_FEATURES_DEFAULT).sort()).toEqual(
      Object.keys(old).sort(),
    );
  });

  test("a direct run refused while its switch is off is a policy refusal (403)", () => {
    expect(githubRefusalStatus("actions_off")).toBe(403);
  });
});

describe("the workspace ceiling's merge key", () => {
  test("is off when a stored ceiling lacks it, and on only when saved on", () => {
    expect(githubCeilingSchema.parse(GITHUB_FEATURES_NONE)).toEqual(
      GITHUB_CEILING_NONE,
    );
    expect(GITHUB_CEILING_NONE.merge).toBe(false);
    expect(
      githubCeilingSchema.parse({ ...GITHUB_FEATURES_NONE, merge: true }).merge,
    ).toBe(true);
    expect(
      githubCeilingSchema.safeParse({ ...GITHUB_FEATURES_NONE, merge: "yes" })
        .success,
    ).toBe(false);
    expect(
      githubCeilingSchema.safeParse({ ...GITHUB_CEILING_NONE, other: true })
        .success,
    ).toBe(false);
  });

  test("is not a feature of an agent row or a release pin, which stay valid without it and refuse it", () => {
    expect(githubFeaturesSchema.safeParse(GITHUB_FEATURES_NONE).success).toBe(
      true,
    );
    expect(githubFeaturesSchema.safeParse(GITHUB_CEILING_NONE).success).toBe(
      false,
    );
    const pin = {
      repositories: ["app"],
      push_approval: true,
      features: GITHUB_FEATURES_NONE,
      actions_allow: [],
    };
    expect(agentGitHubSchema.safeParse(pin).success).toBe(true);
    expect(
      agentGitHubSchema.safeParse({ ...pin, features: GITHUB_CEILING_NONE })
        .success,
    ).toBe(false);
  });

  test("a merge asks for contents write and pull requests read, as the ceiling's own key, answered 409 when off", () => {
    expect(githubPermissionsFor("merge", { workflows: false })).toEqual({
      role: "author",
      feature: null,
      ceilingFeature: "merge",
      permissions: { contents: "write", pull_requests: "read" },
    });
    expect(githubRefusalStatus("merge_off")).toBe(409);
  });
});

describe("a pull request template name", () => {
  test("is printable text, one to 100 characters", () => {
    expect(
      pullRequestTemplateNameSchema.safeParse("bug_report.md").success,
    ).toBe(true);
    expect(pullRequestTemplateNameSchema.safeParse("").success).toBe(false);
    expect(
      pullRequestTemplateNameSchema.safeParse("a".repeat(101)).success,
    ).toBe(false);
    expect(pullRequestTemplateNameSchema.safeParse("a\u0000.md").success).toBe(
      false,
    );
  });

  test("refuses a lone surrogate, which the receipt's jsonb cannot hold, and keeps a pair", () => {
    expect(pullRequestTemplateNameSchema.safeParse("\ud800.md").success).toBe(
      false,
    );
    expect(pullRequestTemplateNameSchema.safeParse("🚀.md").success).toBe(true);
  });
});
