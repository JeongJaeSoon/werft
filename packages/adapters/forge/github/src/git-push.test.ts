import { describe, expect, test } from "bun:test";
import { parseLsRemote, workflowsPermissionRefused } from "./git-push.ts";

describe("parseLsRemote", () => {
  test("reads HEAD's symref and each ref's commit", () => {
    const sha = "c".repeat(40);
    expect(
      parseLsRemote(
        `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/agent/x\n`,
      ),
    ).toEqual({
      head: "refs/heads/main",
      refs: new Map([
        ["HEAD", sha],
        ["refs/heads/agent/x", sha],
      ]),
    });
  });
});

describe("workflowsPermissionRefused", () => {
  const ref = "refs/heads/agent/x";
  test("reads GitHub's refusal of a workflow change without the workflows permission", () => {
    expect(
      workflowsPermissionRefused(
        `To https://github.com/acme/app.git\n!\t${"c".repeat(40)}:${ref}\t[remote rejected] (refusing to allow a GitHub App to create or update workflow \`.github/workflows/x.yml\` without \`workflows\` permission)\nDone\n`,
      ),
    ).toBe(true);
  });

  test("an ordinary rejection is not one", () => {
    for (const stdout of [
      `!\t${"c".repeat(40)}:${ref}\t[rejected] (non-fast-forward)\n`,
      `!\t${"c".repeat(40)}:${ref}\t[remote rejected] (pre-receive hook declined)\n`,
      // The phrase alone, outside a refused ref's line, is not GitHub's.
      `=\t${ref}\t[up to date]\nwithout \`workflows\` permission\n`,
      "",
    ]) {
      expect(workflowsPermissionRefused(stdout)).toBe(false);
    }
  });
});
