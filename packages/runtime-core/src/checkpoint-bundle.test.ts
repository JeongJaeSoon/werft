import { describe, expect, test } from "bun:test";

import {
  checkpointBundleRefs,
  MAX_CHECKPOINT_SOURCES,
  peeledCommits,
} from "./checkpoint-bundle.ts";

const head = "1".repeat(40);
const worktree = "2".repeat(40);

describe("checkpoint bundle refs", () => {
  test("reads what a capture writes, the branch as a tag included", () => {
    expect(
      checkpointBundleRefs(
        [
          ["refs/checkpoint/head", head],
          ["refs/checkpoint/worktree", worktree],
          ["refs/checkpoint/branch/heads/main", head],
        ],
        worktree,
      ),
    ).toEqual({
      status: "valid",
      refs: {
        branch: "refs/heads/main",
        head,
        instructions: null,
        sources: [],
        upstream: null,
        worktree,
      },
    });
  });

  test("reads the source branches, sorted by name", () => {
    const other = "3".repeat(40);
    const verdict = checkpointBundleRefs(
      [
        ["refs/checkpoint/head", head],
        ["refs/checkpoint/worktree", worktree],
        ["refs/heads/main", head],
        ["refs/checkpoint/source/guard/docs", other],
        ["refs/checkpoint/source/skills-sample", worktree],
      ],
      worktree,
    );

    expect(verdict).toMatchObject({
      status: "valid",
      refs: {
        sources: [
          { name: "guard/docs", commit: other },
          { name: "skills-sample", commit: worktree },
        ],
      },
    });
  });

  test("refuses more source branches than a capture writes", () => {
    const sources = Array.from(
      { length: MAX_CHECKPOINT_SOURCES + 1 },
      (_, at) => [`refs/checkpoint/source/b${at}`, head] as const,
    );
    const verdict = checkpointBundleRefs(
      [
        ["refs/checkpoint/head", head],
        ["refs/checkpoint/worktree", worktree],
        ...sources,
      ],
      worktree,
    );

    expect(verdict.status === "invalid" && verdict.reason).toContain(
      "source branches",
    );
  });

  test("refuses a source branch that is not a commit", () => {
    const verdict = checkpointBundleRefs(
      [
        ["refs/checkpoint/head", head],
        ["refs/checkpoint/worktree", worktree],
        ["refs/checkpoint/source/docs", null],
      ],
      worktree,
    );

    expect(verdict.status === "invalid" && verdict.reason).toContain(
      "refs/checkpoint/source/docs is not a commit",
    );
  });

  test("reads the branch's upstream on origin", () => {
    expect(
      checkpointBundleRefs(
        [
          ["refs/checkpoint/head", head],
          ["refs/checkpoint/worktree", worktree],
          ["refs/heads/work", head],
          ["refs/checkpoint/upstream/heads/main", worktree],
        ],
        worktree,
      ),
    ).toMatchObject({
      status: "valid",
      refs: { upstream: { commit: worktree, merge: "refs/heads/main" } },
    });
  });

  test.each([
    [
      "a ref no capture writes",
      [["refs/tags/v1", head]],
      "carries refs a capture does not write: refs/tags/v1",
    ],
    [
      "a second branch",
      [
        ["refs/heads/a", head],
        ["refs/heads/b", head],
      ],
      "carries refs a capture does not write: refs/heads/b",
    ],
    [
      "a branch away from HEAD",
      [["refs/heads/main", worktree]],
      "refs/heads/main is not at HEAD's commit",
    ],
    [
      "a branch tag outside refs/heads",
      [["refs/checkpoint/branch/tags/v1", head]],
      "which is no branch",
    ],
    [
      "an instructions ref that is not a commit",
      [["refs/checkpoint/instructions", null]],
      "refs/checkpoint/instructions is not a commit",
    ],
    [
      "an upstream without a branch",
      [["refs/checkpoint/upstream/heads/main", head]],
      "which is no upstream of a branch",
    ],
    [
      "an upstream that is not a commit",
      [
        ["refs/heads/main", head],
        ["refs/checkpoint/upstream/heads/main", null],
      ],
      "refs/checkpoint/upstream/heads/main is not a commit",
    ],
    [
      "a ref listed twice",
      [["refs/checkpoint/head", head]],
      "lists refs/checkpoint/head twice",
    ],
  ] as const)("refuses %s", (_, extra, reason) => {
    const verdict = checkpointBundleRefs(
      [
        ["refs/checkpoint/head", head],
        ["refs/checkpoint/worktree", worktree],
        ...extra,
      ],
      worktree,
    );

    expect(verdict).toMatchObject({ status: "invalid" });
    expect(verdict.status === "invalid" && verdict.reason).toContain(reason);
  });

  test("refuses a bundle without the worktree ref, or pinning another commit", () => {
    expect(
      checkpointBundleRefs([["refs/checkpoint/head", head]], head),
    ).toMatchObject({ status: "invalid" });
    expect(
      checkpointBundleRefs(
        [
          ["refs/checkpoint/head", head],
          ["refs/checkpoint/worktree", worktree],
        ],
        head,
      ),
    ).toMatchObject({ status: "invalid" });
  });

  test("peels a commit and a tag over one, nothing else", () => {
    expect(
      peeledCommits(
        [
          `refs/a commit ${head} `,
          `refs/b tag ${"3".repeat(40)} commit ${worktree}`,
          `refs/c tag ${"4".repeat(40)} tag ${"5".repeat(40)}`,
          `refs/d tree ${"6".repeat(40)} `,
          "",
        ].join("\n"),
      ),
    ).toEqual(
      new Map([
        ["refs/a", head],
        ["refs/b", worktree],
        ["refs/c", null],
        ["refs/d", null],
      ]),
    );
  });
});
