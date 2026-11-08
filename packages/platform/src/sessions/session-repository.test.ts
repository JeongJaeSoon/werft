import { describe, expect, test } from "bun:test";
import {
  attachedRepositoriesOf,
  sessionRepositoryOf,
} from "./session-repository.ts";

describe("sessionRepositoryOf", () => {
  test("names a GitHub repository owner/name and keeps the row's branch", () => {
    expect(
      sessionRepositoryOf({
        repositoryMode: "repository",
        repositoryId: "app",
        repoUrl: "https://github.com/acme/app.git",
        branch: "release/1.2",
      }),
    ).toEqual({ id: "app", full_name: "acme/app", branch: "release/1.2" });
  });

  test("never carries userinfo, a token in the query or the host", () => {
    const repository = sessionRepositoryOf({
      repositoryMode: "repository",
      repositoryId: null,
      repoUrl:
        "https://agent:userinfo-mark@github.example.com/acme/app.git?access_token=query-mark",
      branch: "main",
    });
    expect(repository).toEqual({
      id: null,
      full_name: "acme/app",
      branch: "main",
    });
    const text = JSON.stringify(repository);
    for (const leak of ["userinfo-mark", "query-mark", "agent", "example"]) {
      expect(text).not.toContain(leak);
    }
  });

  test("names any forge's path, groups and underscores included", () => {
    for (const [repoUrl, fullName] of [
      ["https://git.example.com/team_name/app.git", "team_name/app"],
      ["https://gitlab.example.com/group/sub/app.git/", "group/sub/app"],
      ["http://fake-git:3000/agent/sample-app.git", "agent/sample-app"],
    ] as const) {
      expect(
        sessionRepositoryOf({
          repositoryMode: "repository",
          repositoryId: "app",
          repoUrl,
          branch: "main",
        })?.full_name,
      ).toBe(fullName);
    }
  });

  test("falls back to the catalog key for a URL that is not owner/name", () => {
    expect(
      sessionRepositoryOf({
        repositoryMode: "repository",
        repositoryId: "sample-app",
        repoUrl: "http://git-server/sample-app.git",
        branch: "main",
      }),
    ).toEqual({ id: "sample-app", full_name: "sample-app", branch: "main" });
  });

  test("a legacy row with neither a key nor an owner/name URL has no name", () => {
    expect(
      sessionRepositoryOf({
        repositoryMode: "repository",
        repositoryId: null,
        repoUrl: "file:///srv/git/deep/path/app.git",
        branch: "main",
      }),
    ).toEqual({ id: null, full_name: null, branch: "main" });
  });

  test("a session created without a repository has none", () => {
    expect(
      sessionRepositoryOf({
        repositoryMode: "none",
        repositoryId: null,
        repoUrl: null,
        branch: null,
      }),
    ).toBeNull();
  });
});

describe("attachedRepositoriesOf", () => {
  const catalog = {
    web: { url: "https://github.com/acme/web.git" },
    api: { url: "https://github.com/acme/api" },
    local: { url: "file:///srv/git/deep/path/local.git" },
    leaky: {
      url: "https://agent:userinfo-mark@github.example.com/acme/leaky.git?access_token=query-mark",
    },
  };

  test("names each id from the catalog URL, in id order", () => {
    expect(attachedRepositoriesOf(["web", "api"], catalog)).toEqual([
      { id: "api", full_name: "acme/api" },
      { id: "web", full_name: "acme/web" },
    ]);
  });

  test("an id without an owner/name URL is named by its key, one the catalog dropped by null", () => {
    expect(attachedRepositoriesOf(["gone", "local"], catalog)).toEqual([
      { id: "gone", full_name: null },
      { id: "local", full_name: "local" },
    ]);
  });

  test("lists an id once", () => {
    expect(attachedRepositoriesOf(["web", "web"], catalog)).toEqual([
      { id: "web", full_name: "acme/web" },
    ]);
  });

  test("never carries userinfo, a token in the query or the host", () => {
    const text = JSON.stringify(attachedRepositoriesOf(["leaky"], catalog));
    expect(text).toContain("acme/leaky");
    for (const leak of ["userinfo-mark", "query-mark", "agent", "example"]) {
      expect(text).not.toContain(leak);
    }
  });

  test("none attached is [], an unknown list is absent", () => {
    expect(attachedRepositoriesOf([], catalog)).toEqual([]);
    expect(attachedRepositoriesOf(null, catalog)).toBeUndefined();
    expect(attachedRepositoriesOf(undefined, catalog)).toBeUndefined();
  });
});
