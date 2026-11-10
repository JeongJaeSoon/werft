import { describe, expect, test } from "bun:test";
import { GitHubCallError } from "../ports/github-gate.ts";
import type { MakeForgeSubject } from "./forge-contract-subject.ts";

/**
 * What every `PullRequestMergeable` promises: a squash merge of the head the
 * caller names answers the merge commit; a pull request found already merged
 * answers `already: true`, as not this call's merge; one that cannot be merged
 * now (a 400 or 405) throws `GitHubCallError` with that status.
 */
export function describePullRequestMergeableContract(make: MakeForgeSubject) {
  describe("PullRequestMergeable", () => {
    test("merges an open pull request on its head and answers the merge commit", async () => {
      const subject = await make();
      const number = await subject.openPullRequest(await subject.newBranch());
      const result = await subject.api.mergePullRequest({
        number,
        sha: subject.pullRequestHeadSha(number),
      });
      expect(result).toEqual({
        merged: true,
        sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      expect(subject.pullRequestOnForge(number)).toMatchObject({
        state: "closed",
        merged: true,
      });
    });

    test("a pull request already merged answers as merged before this call, not by it", async () => {
      const subject = await make();
      const number = await subject.openPullRequest(await subject.newBranch());
      subject.settleOnForge(number, "merged");
      expect(
        await subject.api.mergePullRequest({
          number,
          sha: subject.pullRequestHeadSha(number),
        }),
      ).toEqual({
        merged: true,
        sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        already: true,
      });
    });

    test("one the forge will not merge now throws GitHubCallError with its status", async () => {
      const subject = await make();
      const number = await subject.openPullRequest(await subject.newBranch());
      subject.settleOnForge(number, "closed");
      const refused = await subject.api
        .mergePullRequest({ number, sha: subject.pullRequestHeadSha(number) })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(GitHubCallError);
      expect([400, 405]).toContain((refused as GitHubCallError).status ?? 0);
      expect((refused as Error).message).not.toContain("not mergeable");
    });
  });
}
