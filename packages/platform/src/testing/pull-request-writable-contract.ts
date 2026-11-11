import { describe, expect, test } from "bun:test";
import { ForgeCredentialError } from "../action/ports/forge.ts";
import type { MakeForgeSubject } from "./forge-contract-subject.ts";

/**
 * What every `PullRequestWritable` promises: creating for a head that already
 * has an open pull request answers that one with `created: false` and makes no
 * second; `updatePullRequestBody` hands the current body to `edit` and writes
 * back what it returns; a failed call throws `ForgeCredentialError`, never a
 * made-up value.
 */
export function describePullRequestWritableContract(make: MakeForgeSubject) {
  describe("PullRequestWritable", () => {
    test("states the longest body it takes", async () => {
      const { api } = await make();
      expect(Number.isInteger(api.maxBodyLength)).toBe(true);
      expect(api.maxBodyLength).toBeGreaterThan(0);
    });

    test("creates a pull request, and answers the open one when the head already has it", async () => {
      const { api, newBranch, pullRequestOnForge, repository } = await make();
      const branch = await newBranch();
      const created = await api.createPullRequest({
        head: branch,
        base: repository.defaultBranch,
        title: "Agent result",
        body: "What the session did.",
      });
      expect(created).toMatchObject({
        created: true,
        state: "open",
        head: branch,
        base: repository.defaultBranch,
        mergedAt: null,
        closedAt: null,
      });
      expect(pullRequestOnForge(created.number)).toMatchObject({
        title: "Agent result",
        body: "What the session did.",
        state: "open",
      });
      const again = await api.createPullRequest({
        head: branch,
        base: repository.defaultBranch,
        title: "Another try",
        body: "",
      });
      expect(again).toEqual({ ...created, created: false });
      expect(pullRequestOnForge(created.number)?.title).toBe("Agent result");
      expect(pullRequestOnForge(created.number + 1)).toBeNull();
    });

    test("a create the forge refuses throws ForgeCredentialError", async () => {
      const { api, repository } = await make();
      const refused = await api
        .createPullRequest({
          head: "agent/missing",
          base: repository.defaultBranch,
          title: "nowhere",
          body: "",
        })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ForgeCredentialError);
    });

    test("updates the body from what edit makes of the current one, and the title when one is given", async () => {
      const { api, newBranch, openPullRequest, pullRequestOnForge } =
        await make();
      const number = await openPullRequest(await newBranch());
      const seen: string[] = [];
      await api.updatePullRequestBody(number, (current) => {
        seen.push(current);
        return `${current}\n\ntail`;
      });
      expect(seen).toEqual(["What the session did."]);
      expect(pullRequestOnForge(number)).toMatchObject({
        title: "Agent result",
        body: "What the session did.\n\ntail",
      });
      await api.updatePullRequestBody(number, (current) => current, "Retitled");
      expect(pullRequestOnForge(number)).toMatchObject({
        title: "Retitled",
        body: "What the session did.\n\ntail",
      });
    });

    test("an update of a pull request the forge does not have throws", async () => {
      const { api } = await make();
      await expect(
        api.updatePullRequestBody(999, (current) => current),
      ).rejects.toThrow();
    });

    test("closes and reopens a pull request, answering it as the forge left it", async () => {
      const { api, newBranch, openPullRequest, pullRequestOnForge } =
        await make();
      const number = await openPullRequest(await newBranch());
      const closed = await api.setPullRequestState(number, "closed");
      expect(closed).toMatchObject({ number, state: "closed" });
      expect(closed.closedAt).not.toBeNull();
      expect(pullRequestOnForge(number)?.state).toBe("closed");
      expect(await api.setPullRequestState(number, "open")).toMatchObject({
        number,
        state: "open",
        closedAt: null,
      });
    });

    test("a merged pull request is not closed, and the refusal throws ForgeCredentialError", async () => {
      const { api, newBranch, openPullRequest, settleOnForge } = await make();
      const number = await openPullRequest(await newBranch());
      settleOnForge(number, "merged");
      expect(
        await api
          .setPullRequestState(number, "closed")
          .catch((error: unknown) => error),
      ).toBeInstanceOf(ForgeCredentialError);
    });
  });
}
