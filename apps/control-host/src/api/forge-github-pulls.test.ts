import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { sanitizeFields } from "@werft-ai/observability";
import { ForgeCredentialError, GitHubCallError } from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import { createGitHubConnection, RATE_LIMIT_RETRIES } from "./forge-github.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const repo = { owner: "acme", name: "app" };
const head = "agent/0b9a2f3e-5c4d-4e6f-8a7b-9c0d1e2f3a4b";
const PULLS = { contents: "read", pull_requests: "write" } as const;

let github: FakeGitHub;
beforeAll(async () => {
  github = await startFakeGitHub({ appId: 101, publicKey });
  await github.createRepository("acme", "app", { "README.md": "hello\n" });
  await github.writeUnrelatedCommit("acme", "app", head);
});
afterAll(async () => {
  await github.stop();
});

async function appForge() {
  const warnings: Array<Record<string, unknown>> = [];
  const connection = createGitHubConnection({
    apiBase: github.origin,
    credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
    logger: {
      warn: (message: string, fields?: Record<string, unknown>) =>
        warnings.push({ message, ...fields }),
    },
    retryAfterBaseMs: 1,
    paced: false,
  });
  const { credential } = await connection.credential(repo, PULLS);
  return { forge: connection.api(repo, credential), connection, warnings };
}

/** An App connection's API against a stub server on `port`. */
async function appForgeAt(port: number | undefined) {
  const { connection: issuer } = await appForge();
  const { credential } = await issuer.credential(repo, PULLS);
  const connection = createGitHubConnection({
    apiBase: `http://127.0.0.1:${port}`,
    credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
    retryAfterBaseMs: 1,
    paced: false,
  });
  return connection.api(repo, credential);
}

describe("GitHub pull requests", () => {
  test("opens a pull request with a token for that one repository and pull_requests:write, and finds it again", async () => {
    const tokensBefore = github.tokenRequests.length;
    const { forge } = await appForge();
    const opened = await forge.createPullRequest({
      head,
      base: "main",
      title: "Agent result",
      body: "What the session did.",
    });
    expect(opened).toMatchObject({
      number: 1,
      state: "open",
      head,
      headSha: "1".repeat(40),
      base: "main",
    });
    expect(opened.url).toBe(`${github.origin}/acme/app/pull/1`);
    const { created, ...pull } = opened;
    expect(created).toBe(true);
    expect(pull).toMatchObject({ mergedAt: null, closedAt: null });
    expect(github.tokenRequests.slice(tokensBefore)).toEqual([
      expect.objectContaining({
        status: 201,
        body: {
          repositories: ["app"],
          permissions: { contents: "read", pull_requests: "write" },
        },
      }),
    ]);
    expect(github.pullRequests("acme", "app")).toEqual([
      expect.objectContaining({
        head,
        base: "main",
        title: "Agent result",
        body: "What the session did.",
      }),
    ]);

    expect(await forge.findPullRequestForBranch(head)).toEqual(pull);
    expect(await forge.findPullRequestForBranch("agent/none")).toBeNull();
    expect(await forge.findPullRequestsForBranch("agent/none")).toEqual([]);
    expect(await forge.findPullRequestsForBranch(head)).toEqual([
      expect.objectContaining({
        ...pull,
        body: "What the session did.",
        headRepository: "acme/app",
      }),
    ]);
    // GitHub answers 422 for the open head; the one it names is answered,
    // as not created by this call.
    expect(
      await forge.createPullRequest({
        head,
        base: "main",
        title: "again",
        body: "",
      }),
    ).toEqual({ ...pull, created: false });
    expect(github.pullRequests("acme", "app")).toHaveLength(1);
    expect(github.tokenRequests.length - tokensBefore).toBe(1);

    const seen: string[] = [];
    await forge.updatePullRequestBody(opened.number, (current) => {
      seen.push(current);
      return `${current}\n\ntail`;
    });
    expect(seen).toEqual(["What the session did."]);
    expect(github.pullRequests("acme", "app")[0]?.body).toBe(
      "What the session did.\n\ntail",
    );
    await forge.updatePullRequestBody(
      opened.number,
      (current) => current,
      "Retitled",
    );
    expect(github.pullRequests("acme", "app")[0]).toMatchObject({
      title: "Retitled",
      body: "What the session did.\n\ntail",
    });
    expect(
      github.apiRequests.filter((request) => request.method === "PATCH").at(-1)
        ?.body,
    ).toEqual({ title: "Retitled" });
    await expect(
      forge.updatePullRequestBody(999, (current) => current),
    ).rejects.toThrow();
  });

  test("a refused create logs GitHub's reason, not only its status", async () => {
    const { forge, warnings } = await appForge();
    const error = await forge
      .createPullRequest({
        head: "agent/missing",
        base: "main",
        title: "nowhere",
        body: "",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(ForgeCredentialError);
    const fields = {
      request: "pull request create",
      status: 422,
      error: "HttpError",
      github_reason: "Validation Failed",
      github_errors: ["head"],
    };
    expect(warnings).toEqual([{ message: "GitHub request failed", ...fields }]);
    // The production logger drops message-like keys; these survive it.
    expect(sanitizeFields(fields)).toEqual(fields);
  });

  test("an open pull request is found even when a newer one for the branch is closed", async () => {
    const { forge } = await appForge();
    const pulls = github.pullRequests("acme", "app");
    pulls.push({
      number: 99,
      head,
      base: "release",
      title: "closed later",
      body: "",
      state: "closed",
      merged_at: null,
      closed_at: "2026-10-01T00:00:00Z",
      author_app_id: 1,
      html_url: `${github.origin}/acme/app/pull/99`,
    });
    try {
      expect(await forge.findPullRequestForBranch(head)).toMatchObject({
        number: 1,
        state: "open",
      });
    } finally {
      pulls.pop();
    }
  });

  test("a pull request token is not the contents token, and neither is reused for the other", async () => {
    const fresh = createGitHubConnection({
      apiBase: github.origin,
      credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
      retryAfterBaseMs: 1,
      paced: false,
    });
    const before = github.tokenRequests.length;
    await fresh.credential(repo, { contents: "write" });
    const { credential } = await fresh.credential(repo, PULLS);
    await fresh.api(repo, credential).findPullRequestForBranch(head);
    await fresh.credential(repo, { contents: "write" });
    expect(
      github.tokenRequests.slice(before).map((asked) => asked.body),
    ).toEqual([
      { repositories: ["app"], permissions: { contents: "write" } },
      {
        repositories: ["app"],
        permissions: { contents: "read", pull_requests: "write" },
      },
    ]);
  });

  test("upserts one comment per marker", async () => {
    const { forge } = await appForge();
    const marker = "<!-- werft:s:status -->";
    const first = await forge.upsertComment(1, marker, "Running.");
    expect(first.created).toBe(true);
    const other = await forge.upsertComment(
      1,
      "<!-- werft:s:other -->",
      "Elsewhere.",
    );
    const second = await forge.upsertComment(1, marker, "Done.");
    expect(second).toEqual({ id: first.id, url: first.url, created: false });
    expect(github.comments("acme", "app", 1)).toEqual([
      expect.objectContaining({ id: first.id, body: `Done.\n\n${marker}` }),
      expect.objectContaining({ id: other.id }),
    ]);
  });

  test("two first comments for one marker at once leave one comment", async () => {
    const { forge } = await appForge();
    const marker = "<!-- werft:s:racing -->";
    const [a, b] = await Promise.all([
      forge.upsertComment(1, marker, "One."),
      forge.upsertComment(1, marker, "Two."),
    ]);
    expect([a.created, b.created]).toEqual([true, false]);
    expect(
      github
        .comments("acme", "app", 1)
        .filter((comment) => comment.body.includes(marker)),
    ).toEqual([
      expect.objectContaining({ id: a.id, body: `Two.\n\n${marker}` }),
    ]);
  });

  test("a marker someone else pasted is left alone", async () => {
    const { forge } = await appForge();
    const marker = "<!-- werft:s:pasted -->";
    const pasted = github.addComment("acme", "app", 1, `Copied ${marker}`);
    const ours = await forge.upsertComment(1, marker, "Running.");
    expect(ours.created).toBe(true);
    expect(await forge.upsertComment(1, marker, "Done.")).toEqual({
      ...ours,
      created: false,
    });
    const thread = github.comments("acme", "app", 1);
    expect(thread.find((comment) => comment.id === pasted.id)?.body).toBe(
      `Copied ${marker}`,
    );
    expect(thread.find((comment) => comment.id === ours.id)?.body).toBe(
      `Done.\n\n${marker}`,
    );
  });

  test("past the comments it can read, it fails rather than post a second marked one", async () => {
    const seen: string[] = [];
    const page = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      body: "noise",
      html_url: `h/${index}`,
      user: { id: 7 },
    }));
    const stub = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.method);
        return Response.json(page);
      },
    });
    try {
      const forge = await appForgeAt(stub.port);
      await expect(
        forge.upsertComment(1, "<!-- werft:s:x -->", "Hi"),
      ).rejects.toBeInstanceOf(ForgeCredentialError);
      expect(seen).toEqual(Array(10).fill("GET"));
    } finally {
      await stub.stop(true);
    }
  });

  test("a merge is one PUT that squashes and pins the head sha, and answers what GitHub did", async () => {
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    const stub = Bun.serve({
      port: 0,
      async fetch(request) {
        sent.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: await request.json(),
        });
        return Response.json({ merged: true, sha: "d".repeat(40) });
      },
    });
    try {
      const forge = await appForgeAt(stub.port);
      expect(
        await forge.mergePullRequest({ number: 7, sha: "a".repeat(40) }),
      ).toEqual({
        merged: true,
        sha: "d".repeat(40),
      });
      expect(sent).toEqual([
        {
          method: "PUT",
          path: "/repos/acme/app/pulls/7/merge",
          body: { merge_method: "squash", sha: "a".repeat(40) },
        },
      ]);
    } finally {
      await stub.stop(true);
    }
  });

  test("a merge GitHub refuses with 405 or 409 reaches the caller as a status, not a merge", async () => {
    for (const status of [405, 409]) {
      const stub = Bun.serve({
        port: 0,
        fetch: () => Response.json({ message: "secret echo" }, { status }),
      });
      try {
        const forge = await appForgeAt(stub.port);
        const error = await forge
          .mergePullRequest({ number: 7, sha: "a".repeat(40) })
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({ status });
        expect(JSON.stringify(error)).not.toContain("secret echo");
      } finally {
        await stub.stop(true);
      }
    }
  });

  test("isAncestor asks one compare and reads only ahead and identical as yes", async () => {
    const statuses = ["ahead", "identical", "behind", "diverged"];
    const paths: string[] = [];
    const stub = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (!pathname.includes("/compare/")) return Response.json([]);
        paths.push(decodeURIComponent(pathname));
        return Response.json({ status: statuses[paths.length - 1] });
      },
    });
    try {
      const forge = await appForgeAt(stub.port);
      const answers = [];
      for (let index = 0; index < statuses.length; index += 1) {
        answers.push(await forge.isAncestor("a".repeat(40), "b".repeat(40)));
      }
      expect(answers).toEqual([true, true, false, false]);
      expect(paths[0]).toBe(
        `/repos/acme/app/compare/${"a".repeat(40)}...${"b".repeat(40)}`,
      );
    } finally {
      await stub.stop(true);
    }
  });

  test("isAncestor throws when GitHub does not know a commit", async () => {
    const stub = Bun.serve({
      port: 0,
      fetch: () => Response.json({ message: "Not Found" }, { status: 404 }),
    });
    try {
      const forge = await appForgeAt(stub.port);
      await expect(
        forge.isAncestor("a".repeat(40), "b".repeat(40)),
      ).rejects.toBeInstanceOf(ForgeCredentialError);
    } finally {
      await stub.stop(true);
    }
  });

  test("reads a branch head, a tree and a blob by SHA, one level at a time, without a body in any failure", async () => {
    const seen: string[] = [];
    const stub = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname, search } = new URL(request.url);
        seen.push(`${request.method} ${pathname}${search}`);
        if (pathname.endsWith("/branches/main")) {
          return Response.json({
            name: "main",
            commit: {
              sha: "c".repeat(40),
              commit: { tree: { sha: "t".repeat(40) } },
            },
          });
        }
        if (pathname.endsWith(`/git/trees/${"t".repeat(40)}`)) {
          return Response.json({
            sha: "t".repeat(40),
            truncated: true,
            tree: [
              {
                path: "a.md",
                mode: "100644",
                type: "blob",
                sha: "b".repeat(40),
                size: 12,
              },
              {
                path: "link",
                mode: "120000",
                type: "blob",
                sha: "d".repeat(40),
                size: 3,
              },
              {
                path: ".github",
                mode: "040000",
                type: "tree",
                sha: "e".repeat(40),
              },
              {
                path: "sub",
                mode: "160000",
                type: "commit",
                sha: "f".repeat(40),
              },
            ],
          });
        }
        if (pathname.endsWith(`/git/blobs/${"b".repeat(40)}`)) {
          return Response.json({
            encoding: "base64",
            size: 5,
            content: Buffer.from("héllo").toString("base64"),
          });
        }
        return Response.json({ message: "secret echo" }, { status: 502 });
      },
    });
    try {
      const forge = await appForgeAt(stub.port);
      expect(await forge.getBranchHead("main")).toEqual({
        commitSha: "c".repeat(40),
        treeSha: "t".repeat(40),
      });
      const tree = await forge.readTree("t".repeat(40));
      expect(tree.truncated).toBe(true);
      expect(tree.entries).toEqual([
        {
          name: "a.md",
          mode: "100644",
          type: "blob",
          sha: "b".repeat(40),
          size: 12,
        },
        {
          name: "link",
          mode: "120000",
          type: "blob",
          sha: "d".repeat(40),
          size: 3,
        },
        {
          name: ".github",
          mode: "040000",
          type: "tree",
          sha: "e".repeat(40),
          size: null,
        },
        {
          name: "sub",
          mode: "160000",
          type: "commit",
          sha: "f".repeat(40),
          size: null,
        },
      ]);
      expect(
        new TextDecoder().decode(await forge.readBlob("b".repeat(40))),
      ).toBe("héllo");
      // Never recursive, never through the Contents API.
      expect(seen.every((line) => !line.includes("recursive"))).toBe(true);
      expect(seen.every((line) => !line.includes("/contents/"))).toBe(true);
      const failed = await forge
        .readBlob("9".repeat(40))
        .catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(GitHubCallError);
      expect((failed as GitHubCallError).status).toBe(502);
      expect((failed as GitHubCallError).message).not.toContain("secret");
    } finally {
      await stub.stop(true);
    }
  });

  test("a failed repository lookup logs its status, not what GitHub answered", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const stub = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ message: "private-response-content" }, { status: 500 }),
    });
    try {
      const { connection: issuer } = await appForge();
      const { credential } = await issuer.credential(repo, PULLS);
      const connection = createGitHubConnection({
        apiBase: `http://127.0.0.1:${stub.port}`,
        credentials: {
          kind: "app",
          appId: 101,
          installationId: 202,
          privateKey,
        },
        logger: {
          warn: (message: string, fields?: Record<string, unknown>) =>
            warnings.push({ message, ...fields }),
        },
        retryAfterBaseMs: 1,
        paced: false,
      });
      const failed = await connection
        .api(repo, credential)
        .getRepository()
        .catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(GitHubCallError);
      expect(warnings.length).toBeGreaterThan(0);
      expect(JSON.stringify(warnings)).not.toContain("private-response");
    } finally {
      await stub.stop(true);
    }
  });

  test("a new comment the forge answered 5xx is not posted again", async () => {
    const seen: string[] = [];
    const stub = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.method);
        return request.method === "GET"
          ? Response.json([])
          : Response.json({ message: "Bad Gateway" }, { status: 502 });
      },
    });
    try {
      const forge = await appForgeAt(stub.port);
      await expect(
        forge.upsertComment(1, "<!-- werft:s:y -->", "Hi"),
      ).rejects.toBeInstanceOf(ForgeCredentialError);
      expect(seen).toEqual(["GET", "POST"]);
    } finally {
      await stub.stop(true);
    }
  });

  test("waits out a secondary rate limit by retry-after and a primary one by x-ratelimit-reset", async () => {
    const { forge, warnings } = await appForge();
    await forge.findPullRequestForBranch(head);
    const before = github.apiRequests.length;
    github.rateLimitNext(1, "secondary", 1);
    expect(await forge.findPullRequestForBranch(head)).not.toBeNull();
    github.rateLimitNext(1, "primary", 1);
    expect(await forge.findPullRequestForBranch(head)).not.toBeNull();
    expect(github.apiRequests.slice(before).map((r) => r.status)).toEqual([
      403, 200, 429, 200,
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({
        message: "GitHub rate limit",
        limit: "secondary",
        request: "GET /repos/{owner}/{repo}/pulls",
        retry_after_seconds: 1,
        retrying: true,
      }),
      expect.objectContaining({ limit: "primary", retrying: true }),
    ]);
  });

  test("gives up after a bounded number of rate-limited retries, and a long wait is not taken", async () => {
    const { forge, warnings } = await appForge();
    await forge.findPullRequestForBranch(head);
    const before = github.apiRequests.length;
    github.rateLimitNext(10, "secondary", 1);
    const error = await forge
      .findPullRequestForBranch(head)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForgeCredentialError);
    expect((error as Error).message).toBe(
      "GitHub pull request lookup failed (403)",
    );
    expect(github.apiRequests.length - before).toBe(RATE_LIMIT_RETRIES + 1);

    github.rateLimitNext(1, "secondary", 3600);
    const waited = await forge
      .findPullRequestForBranch(head)
      .catch((e: unknown) => e);
    expect(waited).toBeInstanceOf(ForgeCredentialError);
    expect(warnings.at(-2)).toMatchObject({
      retry_after_seconds: 3600,
      retrying: false,
    });
    github.rateLimitNext(0, "secondary");
    expect(JSON.stringify(warnings)).not.toMatch(/ghs_|token [a-z0-9]/i);
  });
});

describe("reading a pull request for the outcome refresher", () => {
  const callError = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => error,
    );

  test("open → merged, open → closed → open, each with the rate limit the answer named", async () => {
    const { forge } = await appForge();
    const reset = Math.ceil(Date.now() / 1000) + 600;
    github.setRateLimit({ limit: 5000, remaining: 4321, reset });
    try {
      const open = await forge.getPullRequest(1);
      expect(open).toEqual({
        pullRequest: expect.objectContaining({
          number: 1,
          state: "open",
          head,
          headSha: "1".repeat(40),
          mergedAt: null,
          closedAt: null,
          mergeCommitSha: null,
          additions: 3,
          deletions: 1,
          changedFiles: 1,
          commits: 1,
        }),
        rateLimit: {
          limit: 5000,
          remaining: 4321,
          reset: new Date(reset * 1000),
          retryAfterSeconds: null,
        },
      });

      github.setPullRequestState("acme", "app", 1, "closed");
      const closed = (await forge.getPullRequest(1)).pullRequest;
      expect(closed).toMatchObject({ state: "closed", mergedAt: null });
      expect(closed.closedAt).not.toBeNull();

      github.setPullRequestState("acme", "app", 1, "open");
      expect((await forge.getPullRequest(1)).pullRequest).toMatchObject({
        state: "open",
        closedAt: null,
      });

      github.setPullRequestState("acme", "app", 1, "merged");
      const merged = (await forge.getPullRequest(1)).pullRequest;
      expect(merged).toMatchObject({
        state: "closed",
        mergeCommitSha: "c".repeat(40),
      });
      expect(merged.mergedAt).not.toBeNull();
    } finally {
      github.setRateLimit(undefined);
      github.setPullRequestState("acme", "app", 1, "open");
    }
  });

  test("closes and reopens a pull request with one PATCH each, and answers it as GitHub left it", async () => {
    const { forge } = await appForge();
    try {
      const before = github.apiRequests.length;
      const closed = await forge.setPullRequestState(1, "closed");
      expect(closed).toMatchObject({ number: 1, state: "closed", head });
      expect(closed.closedAt).not.toBeNull();
      expect((await forge.getPullRequest(1)).pullRequest.state).toBe("closed");
      expect(await forge.setPullRequestState(1, "open")).toMatchObject({
        state: "open",
        closedAt: null,
      });
      expect(
        github.apiRequests
          .slice(before)
          .filter((request) => request.method === "PATCH")
          .map((request) => request.body),
      ).toEqual([{ state: "closed" }, { state: "open" }]);

      github.setPullRequestState("acme", "app", 1, "merged");
      expect(
        await forge.setPullRequestState(1, "closed").catch((error) => error),
      ).toBeInstanceOf(ForgeCredentialError);
    } finally {
      github.setPullRequestState("acme", "app", 1, "open");
    }
  });

  test("a 500 is sent once and not retried; a 404 names its status", async () => {
    const { forge, warnings } = await appForge();
    await forge.getPullRequest(1);
    const before = github.apiRequests.length;
    github.failNext(1, 500);
    const failed = await callError(forge.getPullRequest(1));
    expect(failed).toBeInstanceOf(GitHubCallError);
    expect(failed).toMatchObject({ status: 500 });
    expect(github.apiRequests.length - before).toBe(1);

    expect(await callError(forge.getPullRequest(404))).toMatchObject({
      status: 404,
    });
    expect(warnings.at(-1)).toEqual({
      message: "GitHub request failed",
      request: "pull request read",
      status: 404,
      error: "HttpError",
    });
  });

  test("a rate limit is not waited out: the one answer fails carrying the reset", async () => {
    const { forge } = await appForge();
    await forge.getPullRequest(1);
    const before = github.apiRequests.length;
    github.rateLimitNext(1, "primary", 60);
    const limited = await callError(forge.getPullRequest(1));
    expect(github.apiRequests.length - before).toBe(1);
    expect(limited).toBeInstanceOf(GitHubCallError);
    expect(limited).toMatchObject({
      status: 429,
      rateLimit: { limit: 5000, remaining: 0 },
    });
    expect((limited as GitHubCallError).rateLimit?.reset).toBeInstanceOf(Date);

    github.rateLimitNext(1, "secondary", 30);
    expect(await callError(forge.getPullRequest(1))).toMatchObject({
      status: 403,
      rateLimit: { retryAfterSeconds: 30 },
    });
  });
});

describe("the rate-limit unit of a connection", () => {
  test("an App's unit is its installation", async () => {
    const { connection } = await appForge();
    expect(await connection.quotaKey(repo)).toBe(`app:${github.origin}:202`);
  });
});
