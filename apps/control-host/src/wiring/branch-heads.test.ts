import { describe, expect, test } from "bun:test";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  type GitHubApi,
  GitHubCallError,
  type GitHubReleaseReadGate,
  GitHubUnavailableError,
  type SessionCatalog,
} from "@werft-ai/platform";
import { wireBranchHeads } from "./release-instructions.ts";

const catalog = {
  repositories: {
    app: { url: "https://github.com/acme/app", branch: "release" },
  },
} as unknown as Pick<SessionCatalog, "repositories">;

const READ = {
  ownerId: "workspace-1",
  agentId: "agent-1",
  repositoryId: "app",
  actor: null,
};

function wired(gate: GitHubReleaseReadGate["releaseRead"]) {
  const warned: unknown[] = [];
  const heads = wireBranchHeads({
    catalog,
    gate: () => ({ releaseRead: gate }),
    logger: {
      warn: (...args: unknown[]) => warned.push(args),
    } as unknown as StructuredLogger,
  });
  return { heads, warned };
}

const apiWith = (getBranchHead: GitHubApi["getBranchHead"]) => ({
  repo: { owner: "acme", name: "app" },
  api: { getBranchHead } as unknown as GitHubApi,
});

describe("wireBranchHeads", () => {
  test("reads the catalog branch's head through the release-read gate", async () => {
    const branches: string[] = [];
    const asked: unknown[] = [];
    const { heads } = wired(async (read) => {
      asked.push(read);
      return apiWith(async (branch) => {
        branches.push(branch);
        return { commitSha: "c".repeat(40), treeSha: "d".repeat(40) };
      });
    });
    expect(await heads.branchHead(READ)).toEqual({
      kind: "head",
      commit: "c".repeat(40),
    });
    expect(asked).toEqual([READ]);
    expect(branches).toEqual(["release"]);
  });

  test("a repository outside the catalog or with no App is not on GitHub", async () => {
    let gated = false;
    const { heads } = wired(async () => {
      gated = true;
      return null;
    });
    expect(await heads.branchHead({ ...READ, repositoryId: "gone" })).toEqual({
      kind: "not_on_github",
    });
    expect(gated).toBe(false);
    expect(await heads.branchHead(READ)).toEqual({ kind: "not_on_github" });
  });

  test("GitHub's 404 is a missing branch; other failures throw and are logged", async () => {
    const missing = wired(async () =>
      apiWith(async () => {
        throw new GitHubCallError("branch read", 404, null);
      }),
    );
    expect(await missing.heads.branchHead(READ)).toEqual({
      kind: "branch_missing",
    });
    expect(missing.warned).toEqual([]);
    for (const gate of [
      async () =>
        apiWith(async () => {
          throw new GitHubCallError("branch read", 502, null);
        }),
      async () => {
        throw new GitHubUnavailableError("No author App to read: refused");
      },
    ]) {
      const failing = wired(gate);
      await expect(failing.heads.branchHead(READ)).rejects.toThrow();
      expect(failing.warned).toHaveLength(1);
    }
  });
});
