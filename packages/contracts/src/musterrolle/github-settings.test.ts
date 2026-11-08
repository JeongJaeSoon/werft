import { describe, expect, test } from "bun:test";
import { agentGitHubSchema } from "../kollegium/agents.ts";
import {
  GITHUB_CEILING_NONE,
  GITHUB_FEATURES_NONE,
  githubCeilingSchema,
  githubFeaturesSchema,
  githubPermissionsFor,
  githubRefusalStatus,
  pullRequestTemplateNameSchema,
} from "./github-settings.ts";

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
