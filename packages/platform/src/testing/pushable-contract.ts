import { describe, expect, test } from "bun:test";
import type { GitPushInput, Pushable } from "../action/ports/git-push.ts";

/**
 * What a `Pushable` runs against: the remote, as the harness laid it out, and
 * the checkpoint whose tip commit is pushed. The remote's default branch holds
 * the checkpoint's first commit, so the tip is a fast-forward of it.
 */
export type PushableSubject = {
  pusher: Pushable;
  /** The checkpoint's tip commit: what every `input` pushes. */
  commit: string;
  /** A push of `commit` to `ref`, with a fresh directory, the bundles and a credential. */
  input(ref: string): Promise<GitPushInput>;
  /** Like `input`, for a remote whose history shares nothing with the checkpoint. */
  inputToUnrelatedRemote(ref: string): Promise<GitPushInput>;
  /** Like `input`, for a remote address nothing answers at. */
  inputToUnreachableRemote(ref: string): Promise<GitPushInput>;
  /** What `ref` holds on the remote; null when it does not exist. */
  remoteCommit(ref: string): Promise<string | null>;
  /** The remote's default branch, as `refs/heads/<name>`. */
  defaultBranchRef: string;
  /** Points `ref` on the remote at a commit the checkpoint's history lacks. */
  divergeRemote(ref: string): Promise<void>;
  /** The credential the inputs carry, to look for it in what a push says. */
  secret: string;
};

export type MakePushableSubject = () => Promise<PushableSubject>;

/**
 * What every `Pushable` promises (`ports/git-push.ts`): `<commit>:<ref>` is
 * the one write, and a push that does not go is a typed refusal, never a
 * throw and never a push of something else. `detail` is safe to log: it holds
 * neither a header nor what the remote printed.
 */
export function describePushableContract(make: MakePushableSubject) {
  describe("Pushable", () => {
    test("pushes the commit to a new branch and says it created it", async () => {
      const subject = await make();
      const ref = "refs/heads/agent/new";
      const result = await subject.pusher.push(await subject.input(ref));
      expect(result).toEqual({ status: "pushed", previousCommit: null });
      expect(await subject.remoteCommit(ref)).toBe(subject.commit);
    });

    test("pushing the commit the branch already holds is pushed, naming it as the previous one", async () => {
      const subject = await make();
      const ref = "refs/heads/agent/again";
      await subject.pusher.push(await subject.input(ref));
      const again = await subject.pusher.push(await subject.input(ref));
      expect(again).toEqual({
        status: "pushed",
        previousCommit: subject.commit,
      });
    });

    test("refuses the remote's default branch and writes nothing", async () => {
      const subject = await make();
      const before = await subject.remoteCommit(subject.defaultBranchRef);
      const result = await subject.pusher.push(
        await subject.input(subject.defaultBranchRef),
      );
      expect(result).toMatchObject({
        status: "refused",
        refusal: "default_branch",
      });
      expect(await subject.remoteCommit(subject.defaultBranchRef)).toBe(before);
    });

    test("refuses a branch that is not an ancestor of the commit and leaves it as it was", async () => {
      const subject = await make();
      const ref = "refs/heads/agent/diverged";
      await subject.divergeRemote(ref);
      const before = await subject.remoteCommit(ref);
      const result = await subject.pusher.push(await subject.input(ref));
      expect(result).toMatchObject({
        status: "refused",
        refusal: "non_fast_forward",
      });
      expect(await subject.remoteCommit(ref)).toBe(before);
    });

    test("refuses a new branch whose history shares nothing with the remote's", async () => {
      const subject = await make();
      const ref = "refs/heads/agent/lone";
      const result = await subject.pusher.push(
        await subject.inputToUnrelatedRemote(ref),
      );
      expect(result).toMatchObject({
        status: "refused",
        refusal: "unrelated_history",
      });
      expect(await subject.remoteCommit(ref)).toBeNull();
    });

    test("a remote that does not answer is a push_failed refusal, and its detail leaks no credential", async () => {
      const subject = await make();
      const result = await subject.pusher.push(
        await subject.inputToUnreachableRemote("refs/heads/agent/x"),
      );
      expect(result).toMatchObject({
        status: "refused",
        refusal: "push_failed",
      });
      expect(JSON.stringify(result)).not.toContain(subject.secret);
    });
  });
}
