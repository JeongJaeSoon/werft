import { describe, expect, test } from "bun:test";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  GitHubCallError,
  type GitHubConnectionResolver,
  type GitTreeEntry,
  type SessionCatalog,
  snapshotReleaseInstructions,
} from "@werft-ai/platform";
import type { RuntimeDescriptor } from "@werft-ai/runtime-core";
import { wireReleaseInstructions } from "./release-instructions.ts";

const COMMIT = "e".repeat(40);
const ROOT_TREE = "1".repeat(40);
const DOCS_TREE = "2".repeat(40);

const catalog = {
  repositories: {
    app: {
      url: "https://github.com/acme/app",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
} as unknown as Pick<SessionCatalog, "repositories">;

const descriptors = [
  { kind: "claude_agent_sdk", instructionFiles: ["AGENTS.md", "CLAUDE.md"] },
] as unknown as RuntimeDescriptor[];

const blob = (name: string, sha: string, size: number, mode = "100644") =>
  ({ name, mode, type: "blob", sha, size }) as GitTreeEntry;

function wired(options: {
  choice?: "connection" | "none";
  branch?: "ok" | "missing";
  truncated?: boolean;
  unsized?: string;
}) {
  const asked: string[] = [];
  const warned: unknown[] = [];
  const trees: Record<string, GitTreeEntry[]> = {
    [ROOT_TREE]: [
      ...(options.unsized === undefined
        ? []
        : [{ ...blob("AGENTS.md", "unsized", 0), size: null }]),
      blob("CLAUDE.md", "link", 13, "120000"),
      {
        name: "docs",
        mode: "040000",
        type: "tree",
        sha: DOCS_TREE,
        size: null,
      },
    ],
    [DOCS_TREE]: [blob("rules.md", "rules", 5)],
  };
  const blobs: Record<string, string> = {
    link: "docs/rules.md",
    rules: "rules",
    unsized: options.unsized ?? "",
  };
  const api = {
    getBranchHead: async (branch: string) => {
      asked.push(`branch:${branch}`);
      if (options.branch === "missing") {
        throw new GitHubCallError("branch read", 404, null);
      }
      return { commitSha: COMMIT, treeSha: ROOT_TREE };
    },
    readTree: async (sha: string) => {
      asked.push(`tree:${sha.slice(0, 1)}`);
      return {
        entries: trees[sha] ?? [],
        truncated: options.truncated === true,
      };
    },
    readBlob: async (sha: string) => new TextEncoder().encode(blobs[sha] ?? ""),
  };
  const connection = {
    credential: async (_repo: unknown, permissions: unknown) => {
      asked.push(`credential:${JSON.stringify(permissions)}`);
      return { credential: {}, fresh: true };
    },
    api: () => api,
  };
  const resolver = {
    resolve: async (
      _id: string,
      role: string,
      _repo: unknown,
      opts: unknown,
    ) => {
      asked.push(`resolve:${role}:${JSON.stringify(opts)}`);
      return options.choice === "none"
        ? { kind: "none" }
        : {
            kind: "connection",
            connection,
            connectionId: null,
            pinnedBy: null,
          };
    },
  } as unknown as GitHubConnectionResolver;
  const logger = {
    warn: (...args: unknown[]) => warned.push(args),
  } as unknown as StructuredLogger;
  const source = wireReleaseInstructions({
    catalog,
    resolver: () => resolver,
    descriptors,
    logger,
  });
  return { source, asked, warned };
}

describe("wireReleaseInstructions", () => {
  test("reads the branch's commit with a read-only author token, following a link into a directory", async () => {
    const { source, asked } = wired({});
    expect(
      await snapshotReleaseInstructions(source, "app", "claude_agent_sdk"),
    ).toEqual({
      kind: "text",
      repository_id: "app",
      commit: COMMIT,
      file: "CLAUDE.md",
      text: "rules",
      bytes: 5,
      truncated: false,
    });
    expect(asked).toEqual([
      'resolve:author:{"pin":false}',
      'credential:{"contents":"read"}',
      "branch:main",
      "tree:1",
      "tree:2",
    ]);
  });

  test("a repository the catalog no longer has, or no App reaches, is not read", async () => {
    expect(
      await snapshotReleaseInstructions(
        wired({}).source,
        "gone",
        "claude_agent_sdk",
      ),
    ).toEqual({
      kind: "read_failed",
      repository_id: "gone",
      reason: "not_on_github",
    });
    expect(
      await snapshotReleaseInstructions(
        wired({ choice: "none" }).source,
        "app",
        "claude_agent_sdk",
      ),
    ).toMatchObject({ kind: "read_failed", reason: "not_on_github" });
  });

  test("a missing branch and a cut tree listing are read failures, the second logged", async () => {
    expect(
      await snapshotReleaseInstructions(
        wired({ branch: "missing" }).source,
        "app",
        "claude_agent_sdk",
      ),
    ).toMatchObject({ kind: "read_failed", reason: "branch_missing" });
    const cut = wired({ truncated: true });
    expect(
      await snapshotReleaseInstructions(cut.source, "app", "claude_agent_sdk"),
    ).toMatchObject({ kind: "read_failed", reason: "github_failed" });
    expect(cut.warned).toHaveLength(1);
  });

  test("a file whose size GitHub leaves out is measured in bytes, not characters", async () => {
    const snapshot = await snapshotReleaseInstructions(
      wired({ unsized: "가".repeat(30_000) }).source,
      "app",
      "claude_agent_sdk",
    );
    expect(snapshot).toMatchObject({ kind: "refused", commit: COMMIT });
    expect(snapshot.kind === "refused" && snapshot.reason).toContain(
      "larger than 65536 bytes",
    );
  });
});
