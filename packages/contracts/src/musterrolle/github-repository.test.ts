import { expect, test } from "bun:test";
import {
  catalogIdOfRef,
  listAgentGitHubRepositoriesResponseSchema,
  repositoryRefOf,
} from "./github-repository.ts";

const page = {
  installations: [],
  installation_id: null,
  page: 1,
  per_page: 30,
  total_count: 1,
  repositories: [
    {
      github_repository_id: 5,
      full_name: "acme/widget",
      default_branch: "main",
      private: false,
      catalog_id: "widget",
    },
  ],
  unavailable: null,
};

test("the agent's repository list takes a key its validator does not know, at every level", () => {
  // What a validator written before this answer grew a key sees later.
  const response = {
    ...page,
    from_the_future: 1,
    repositories: page.repositories.map((row) => ({ ...row, later: true })),
    all_repositories: [
      {
        github_repository_id: 5,
        repository: "acme/widget",
        full_name: "acme/widget",
        private: false,
        ref: repositoryRefOf("widget"),
        later: true,
      },
    ],
  };
  expect(
    listAgentGitHubRepositoriesResponseSchema.safeParse(response).success,
  ).toBe(true);
});

test("the list still refuses a value of the wrong shape", () => {
  const bad = {
    ...page,
    repositories: [{ ...page.repositories[0], private: 1 }],
  };
  expect(listAgentGitHubRepositoriesResponseSchema.safeParse(bad).success).toBe(
    false,
  );
});

test("a ref hides the catalog id and gives it back only for what repositoryRefOf made", () => {
  const ref = repositoryRefOf("sample-app");
  expect(ref).not.toContain("sample-app");
  expect(catalogIdOfRef(ref)).toBe("sample-app");
  expect(catalogIdOfRef("sample-app")).toBeNull();
  expect(catalogIdOfRef("r1.")).toBeNull();
  expect(catalogIdOfRef(`${ref}x`)).toBeNull();
});
