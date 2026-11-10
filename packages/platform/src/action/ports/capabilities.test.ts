import { expect, test } from "bun:test";
import type {
  Commentable,
  PullRequestMergeable,
  PullRequestReadable,
  PullRequestWritable,
  RepositoryReadable,
  Reviewable,
  WorkflowRunnable,
} from "./capabilities.ts";
import type { GitHubApi } from "./github-api.ts";

// Compile-time proof (checked by the typecheck, not at run time): the seven
// capabilities together name every member of GitHubApi, and GitHubApi can
// stand in for their sum. A member added to GitHubApi that no capability
// carries makes `Covers` false and this file stop compiling.
type Sum = RepositoryReadable &
  PullRequestReadable &
  PullRequestWritable &
  PullRequestMergeable &
  Commentable &
  Reviewable &
  WorkflowRunnable;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;

const sameMembers: Equal<keyof Sum, keyof GitHubApi> = true;
const apiIsTheSum: GitHubApi extends Sum ? true : false = true;

test("the seven action capabilities add up to GitHubApi", () => {
  expect([sameMembers, apiIsTheSum]).toEqual([true, true]);
});
