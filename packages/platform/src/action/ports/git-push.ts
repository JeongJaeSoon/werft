import type { AttributionMismatchDetail } from "@werft-ai/contracts";
import type { AttributionExpectation } from "@werft-ai/runtime-core";

/**
 * What the pusher holds the new commits to. The server issued the values;
 * nothing the worker reported is in here.
 */
export type GitPushAttribution = {
  /** Every bundle issued to the session; a commit passes on any one. */
  expectations: readonly AttributionExpectation[];
  /** Emails whose Co-authored-by lines no session commit may carry. */
  stripEmails: readonly string[];
  /**
   * The branch the pull request goes to (the catalog entry's), as
   * `refs/heads/<name>`. Its commits, like the default branch's and the
   * target's own, are not the session's to vouch for.
   */
  baseRef: string;
};

export type GitPushInput = {
  /** Owned by the caller, empty but for `bundles`, removed by the caller. */
  directory: string;
  /** The checkpoint's bundle chain, oldest first; the last lands `commit`. */
  bundles: readonly string[];
  commit: string;
  remoteUrl: string;
  /** `refs/heads/<branch>`, the only ref the push may write. */
  ref: string;
  /**
   * Request headers that authenticate to `remoteUrl`, sent to that URL only.
   * They never reach an argument list, a URL, a config file or the disk.
   */
  headers: ReadonlyArray<readonly [string, string]>;
  /**
   * Epoch milliseconds by which every git command has ended, ahead of the
   * claim's lease, so no second pusher takes the row while this one writes.
   */
  deadline: number;
  /** Absent, or with no bundle, no commit is checked (a host without a ledger). */
  attribution?: GitPushAttribution;
};

export type GitPushResult =
  | {
      status: "pushed";
      /** What `ref` held before, or null when the push created it. */
      previousCommit: string | null;
    }
  | {
      status: "refused";
      refusal:
        | "default_branch"
        | "non_fast_forward"
        | "push_failed"
        | "unrelated_history"
        | "attribution_mismatch";
      /** Safe to log: no header, no remote output. */
      detail: string;
      /** `attribution_mismatch` only: the commits, oldest first. */
      mismatches?: AttributionMismatchDetail[];
      /** GitHub refused a change under `.github/workflows/` (no `workflows`). */
      reasonCode?: "workflows_permission_missing";
    };

export interface Pushable {
  push(input: GitPushInput): Promise<GitPushResult>;
}
