import { describe, expect, test } from "bun:test";
import { ForgeCredentialError } from "../action/ports/forge.ts";
import { GitHubCallError } from "../github/ports/github-gate.ts";
import type { MakeForgeSubject } from "./forge-contract-subject.ts";

/**
 * What every `PullRequestReadable` promises. A lookup that finds nothing is
 * `null` or an empty list, a failed one throws `ForgeCredentialError`;
 * `getPullRequest` is one request that is never retried and throws
 * `GitHubCallError` carrying the status; `isAncestor` throws on a commit the
 * forge does not know, for the caller to read as "no".
 */
export function describePullRequestReadableContract(make: MakeForgeSubject) {
  describe("PullRequestReadable", () => {
    test("a branch with no pull request finds none", async () => {
      const { api, newBranch } = await make();
      const branch = await newBranch();
      expect(await api.findPullRequestForBranch(branch)).toBeNull();
      expect(await api.findPullRequestsForBranch(branch)).toEqual([]);
    });

    test("finds the open pull request of a branch, and lists it with its body and head repository", async () => {
      const { api, newBranch, openPullRequest, repository } = await make();
      const branch = await newBranch();
      const number = await openPullRequest(branch);
      const found = await api.findPullRequestForBranch(branch);
      expect(found).toMatchObject({
        number,
        state: "open",
        head: branch,
        base: repository.defaultBranch,
        mergedAt: null,
        closedAt: null,
      });
      const [listed, ...rest] = await api.findPullRequestsForBranch(branch);
      expect(rest).toEqual([]);
      expect(listed).toMatchObject({
        number,
        body: "What the session did.",
      });
      expect(listed?.headRepository).toMatch(/^[^/]+\/[^/]+$/);
    });

    test("lists a closed pull request of the branch, which the open lookup does not find", async () => {
      const { api, newBranch, openPullRequest, settleOnForge } = await make();
      const branch = await newBranch();
      const number = await openPullRequest(branch);
      settleOnForge(number, "closed");
      expect(await api.findPullRequestForBranch(branch)).toBeNull();
      expect(await api.findPullRequestsForBranch(branch)).toEqual([
        expect.objectContaining({ number, state: "closed" }),
      ]);
    });

    test("reads one pull request by number, with the rate limit the answer named", async () => {
      const { api, newBranch, openPullRequest, settleOnForge } = await make();
      const branch = await newBranch();
      const number = await openPullRequest(branch);
      const open = await api.getPullRequest(number);
      expect(open.pullRequest).toMatchObject({
        number,
        state: "open",
        head: branch,
        mergedAt: null,
        closedAt: null,
        mergeCommitSha: null,
      });
      expect(open.rateLimit).toHaveProperty("remaining");
      settleOnForge(number, "merged");
      const merged = (await api.getPullRequest(number)).pullRequest;
      expect(merged.state).toBe("closed");
      expect(merged.mergedAt).not.toBeNull();
      expect(merged.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    });

    test("a failed pull request read is sent once and throws GitHubCallError with the status", async () => {
      const { api, failNext, requestCount } = await make();
      const before = requestCount();
      failNext(500);
      const failed = await api
        .getPullRequest(1)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(GitHubCallError);
      expect(failed).toMatchObject({ status: 500 });
      expect(requestCount() - before).toBe(1);
      expect(
        await api.getPullRequest(404).catch((error: unknown) => error),
      ).toMatchObject({ status: 404 });
    });

    test("a failed lookup throws ForgeCredentialError, never an empty answer", async () => {
      const { api, newBranch, failNext } = await make();
      const branch = await newBranch();
      failNext(404);
      expect(
        await api
          .findPullRequestForBranch(branch)
          .catch((error: unknown) => error),
      ).toBeInstanceOf(ForgeCredentialError);
      failNext(404);
      expect(
        await api
          .findPullRequestsForBranch(branch)
          .catch((error: unknown) => error),
      ).toBeInstanceOf(ForgeCredentialError);
    });

    test("isAncestor is true for a commit and itself or one built on it, false the other way, and throws for a commit the forge does not know", async () => {
      const { api, newBranch, headOf, appendCommit } = await make();
      const branch = await newBranch();
      const base = await headOf(branch);
      const next = await appendCommit(branch);
      expect(await api.isAncestor(base, base)).toBe(true);
      expect(await api.isAncestor(base, next)).toBe(true);
      expect(await api.isAncestor(next, base)).toBe(false);
      expect(
        await api
          .isAncestor(base, "9".repeat(40))
          .catch((error: unknown) => error),
      ).toBeInstanceOf(ForgeCredentialError);
    });
  });
}
