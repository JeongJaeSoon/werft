import { describe, expect, test } from "bun:test";
import { GitHubCallError } from "../ports/github-gate.ts";
import type { MakeForgeSubject } from "./forge-contract-subject.ts";

/**
 * What every `Reviewable` promises: a review is filed on the commit the
 * caller names, with the event asked for, and answered as its id and link.
 * A failed call throws `GitHubCallError` with the status, and is sent once:
 * a review the forge stored and answered 5xx would post twice.
 */
export function describeReviewableContract(make: MakeForgeSubject) {
  describe("Reviewable", () => {
    test("states the longest body it takes", async () => {
      const { api } = await make();
      expect(Number.isInteger(api.maxBodyLength)).toBe(true);
      expect(api.maxBodyLength).toBeGreaterThan(0);
    });

    test("files a review on the commit named, with the event and body asked for", async () => {
      const subject = await make();
      const number = await subject.openPullRequest(await subject.newBranch());
      const commitId = subject.pullRequestHeadSha(number);
      const filed = await subject.api.submitReview({
        number,
        commitId,
        event: "COMMENT",
        body: "Looks right.",
      });
      expect(typeof filed.id).toBe("number");
      expect(filed.html_url).toContain(`/pull/${number}`);
      expect(subject.reviewsOnForge(number)).toEqual([
        { commitId, event: "COMMENT" },
      ]);
    });

    test("a review the forge refuses throws GitHubCallError with its status, sent once", async () => {
      const subject = await make();
      const number = await subject.openPullRequest(await subject.newBranch());
      const before = subject.requestCount();
      subject.failNext(502, 10);
      const failed = await subject.api
        .submitReview({
          number,
          commitId: subject.pullRequestHeadSha(number),
          event: "COMMENT",
        })
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(GitHubCallError);
      expect(failed).toMatchObject({ status: 502 });
      expect(subject.requestCount() - before).toBe(1);
      expect(subject.reviewsOnForge(number)).toEqual([]);
    });
  });
}
