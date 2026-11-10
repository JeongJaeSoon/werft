import { describe, expect, test } from "bun:test";
import type { AgentGitHub } from "@werft-ai/contracts";
import { testCatalog, testRepository } from "../testing/catalog-fakes.ts";
import {
  type AdditionalRepositoryContext,
  additionalRepositoriesOf,
  additionalRepositoryAllowed,
} from "./additional-repositories.ts";

const catalog = testCatalog({
  repositories: {
    app: testRepository("app"),
    docs: testRepository("docs"),
    tools: testRepository("tools"),
    origin: testRepository("origin"),
  },
});

const github = (repositories: string[]): AgentGitHub => ({
  repositories,
  features: {
    workflows: false,
    actions: false,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [],
  push_approval: true,
});

const context = (
  overrides: Partial<AdditionalRepositoryContext> = {},
): AdditionalRepositoryContext => ({
  repositoryId: "app",
  attached: null,
  policySource: "release",
  github: github(["app", "docs", "tools", "origin"]),
  repositoryCeiling: {
    repository_ids: ["app", "docs", "tools", "origin"],
    github_app_repositories: "listed",
  },
  githubEnabled: true,
  ...overrides,
});

describe("additionalRepositoryAllowed", () => {
  test("a repository the release lists and the settings hold", () => {
    expect(additionalRepositoryAllowed(catalog, context(), "docs")).toEqual(
      expect.objectContaining({ url: "https://github.com/acme/docs.git" }),
    );
  });

  test("refuses what the release, ceiling, switch or name rules leave out", () => {
    const cases: Array<[Partial<AdditionalRepositoryContext>, string]> = [
      // The session's own repository is not an additional one.
      [{}, "app"],
      [{ github: github(["app"]) }, "docs"],
      [{}, "origin"],
      [{}, "missing"],
      [{ githubEnabled: false }, "docs"],
      [{ github: null }, "docs"],
      [{ github: "invalid" }, "docs"],
      // The workspace ceiling judges every session: none, or one without it.
      [{ repositoryCeiling: null }, "docs"],
      [
        {
          repositoryCeiling: {
            repository_ids: ["app"],
            github_app_repositories: "listed",
          },
        },
        "docs",
      ],
    ];
    for (const [overrides, id] of cases) {
      expect(
        additionalRepositoryAllowed(catalog, context(overrides), id),
      ).toBeNull();
    }
  });

  test("lists the allowed ones in the release's order", () => {
    expect(
      additionalRepositoriesOf(
        catalog,
        context({ github: github(["tools", "app", "docs", "origin"]) }),
      ).map(({ id }) => id),
    ).toEqual(["tools", "docs"]);
    expect(
      additionalRepositoriesOf(catalog, context({ github: null })),
    ).toEqual([]);
  });

  test("an attached list narrows the release's and never widens it", () => {
    const attachedDocs = context({ attached: ["docs"] });
    expect(additionalRepositoryAllowed(catalog, attachedDocs, "docs")).toEqual(
      expect.objectContaining({ url: "https://github.com/acme/docs.git" }),
    );
    expect(
      additionalRepositoryAllowed(catalog, attachedDocs, "tools"),
    ).toBeNull();
    expect(
      additionalRepositoriesOf(catalog, attachedDocs).map(({ id }) => id),
    ).toEqual(["docs"]);
    // Off the release's list: the attached entry no longer counts.
    const dropped = context({
      attached: ["docs", "tools"],
      github: github(["app", "tools"]),
    });
    expect(additionalRepositoryAllowed(catalog, dropped, "docs")).toBeNull();
    expect(
      additionalRepositoriesOf(catalog, dropped).map(({ id }) => id),
    ).toEqual(["tools"]);
    expect(
      additionalRepositoriesOf(catalog, context({ attached: [] })),
    ).toEqual([]);
  });
});
