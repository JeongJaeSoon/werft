import type { GitHubApi } from "../action/ports/github-api.ts";

/**
 * What a forge capability contract runs against: one repository on a forge
 * (the real thing or a fake of it), the capability's holder, and the few
 * things only the forge's own side can do. A contract never names which
 * forge that is; whatever it cannot do through the capability comes in here.
 *
 * `api` is the whole `GitHubApi` of one implementation so that one subject
 * serves every capability's contract. A contract calls only the members of
 * the capability it checks.
 */
export type ForgeContractSubject = {
  api: GitHubApi;
  repository: {
    defaultBranch: string;
    /** The files of the default branch, path to text. */
    files: Readonly<Record<string, string>>;
  };
  /** A branch the forge knows, with a commit of its own and no pull request. */
  newBranch(): Promise<string>;
  /** The commit `branch` points at on the forge. */
  headOf(branch: string): Promise<string>;
  /** Puts one more commit on `branch`; answers it. */
  appendCommit(branch: string): Promise<string>;
  /** Opens a pull request for `head` into the default branch as a person would. */
  openPullRequest(head: string): Promise<number>;
  /** What the forge itself holds for a pull request. Null when it has none. */
  pullRequestOnForge(number: number): {
    title: string;
    body: string;
    state: "open" | "closed";
    merged: boolean;
  } | null;
  /** The commit the forge says the pull request's head is at. */
  pullRequestHeadSha(number: number): string;
  /** A person merges or closes the pull request on the forge. */
  settleOnForge(number: number, state: "merged" | "closed" | "open"): void;
  /** Comment bodies on the pull request, in the order written. */
  commentsOnForge(number: number): { id: number; body: string }[];
  /** A person (not the credential) writes a comment on the pull request. */
  commentAsPerson(number: number, body: string): void;
  /** Reviews the forge holds for the pull request. */
  reviewsOnForge(number: number): { commitId: string; event: string }[];
  /** Workflow runs the forge holds, with the reruns asked of each. */
  workflowRunsOnForge(): {
    id: number;
    reruns: { failedOnly: boolean }[];
  }[];
  /** The next `times` requests (default 1) answer `status`, whatever they were. */
  failNext(status: number, times?: number): void;
  /** Requests the forge has received since the subject was made. */
  requestCount(): number;
};

export type MakeForgeSubject = () => Promise<ForgeContractSubject>;
