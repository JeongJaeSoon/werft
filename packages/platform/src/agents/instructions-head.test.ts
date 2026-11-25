import { describe, expect, test } from "bun:test";
import type {
  AuthorizationDecision,
  ReleaseInstructions,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import type { GitHubReleaseRead } from "../github/ports/github-gate.ts";
import { SessionServiceError } from "../musterrolle/service-errors.ts";
import {
  type BranchHeadReadable,
  createInstructionsHeadService,
} from "./instructions-head.ts";
import type { AgentRecord } from "./ports/agent-store.ts";

const WORKSPACE = "019a0000-0000-7000-8000-000000000021";
const AGENT = "019a0000-0000-7000-8000-000000000022";
const SNAPSHOT = "a".repeat(40);
const MOVED = "b".repeat(40);
const caller = testCaller(WORKSPACE);

const text: ReleaseInstructions = {
  kind: "text",
  repository_id: "app",
  commit: SNAPSHOT,
  file: "CLAUDE.md",
  text: "Answer in Korean.",
  bytes: 17,
  truncated: false,
};

function service(options: {
  snapshot?: ReleaseInstructions | null;
  noRelease?: boolean;
  noAgent?: boolean;
  head?: BranchHeadReadable["branchHead"];
  allow?: boolean;
  timeoutMs?: number;
}) {
  const reads: GitHubReleaseRead[] = [];
  const heads = createInstructionsHeadService({
    authorization: {
      authorize: async () =>
        (options.allow === false
          ? { outcome: "deny", reason_code: "role", effective_scopes: [] }
          : {
              outcome: "allow",
              reason_code: "ok",
            }) as unknown as AuthorizationDecision,
    },
    agents: {
      get: async () =>
        options.noAgent
          ? null
          : ({
              active_release: options.noRelease
                ? null
                : {
                    instructions_snapshot:
                      options.snapshot === undefined ? text : options.snapshot,
                  },
            } as unknown as AgentRecord),
    },
    heads: {
      branchHead: async (read) => {
        reads.push(read);
        return (
          options.head ?? (async () => ({ kind: "head", commit: SNAPSHOT }))
        )(read);
      },
    },
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });
  return { heads, reads };
}

describe("the instruction snapshot against its branch head (a1/S3)", () => {
  test("a branch past the snapshot's commit is newer; the same commit is not", async () => {
    const moved = service({
      head: async () => ({ kind: "head", commit: MOVED }),
    });
    expect(await moved.heads.getSlackInstructionsHead(caller, AGENT)).toEqual({
      state: "read",
      commit: MOVED,
      newer: true,
    });
    expect(moved.reads).toEqual([
      { ownerId: WORKSPACE, agentId: AGENT, repositoryId: "app", actor: null },
    ]);
    const same = service({});
    expect(await same.heads.getSlackInstructionsHead(caller, AGENT)).toEqual({
      state: "read",
      commit: SNAPSHOT,
      newer: false,
    });
  });

  test("absent and refused snapshots compare their commit too", async () => {
    for (const snapshot of [
      { kind: "absent", repository_id: "app", commit: SNAPSHOT },
      { kind: "refused", repository_id: "app", commit: SNAPSHOT, reason: "x" },
    ] as const) {
      const { heads } = service({
        snapshot,
        head: async () => ({ kind: "head", commit: MOVED }),
      });
      expect((await heads.getSlackInstructionsHead(caller, AGENT)).state).toBe(
        "read",
      );
    }
  });

  test("nothing to compare reads no GitHub", async () => {
    for (const [options, reason] of [
      [{ noRelease: true }, "no_release"],
      [{ snapshot: null }, "no_commit"],
      [{ snapshot: { kind: "no_repository" } }, "no_commit"],
      [
        {
          snapshot: {
            kind: "read_failed",
            repository_id: "app",
            reason: "github_failed",
          },
        },
        "no_commit",
      ],
    ] as const) {
      const { heads, reads } = service(options);
      expect(await heads.getSlackInstructionsHead(caller, AGENT)).toEqual({
        state: "unread",
        reason,
      });
      expect(reads).toEqual([]);
    }
  });

  test("a repository not on GitHub or a gone branch is unread, not a failure", async () => {
    for (const kind of ["not_on_github", "branch_missing"] as const) {
      const { heads } = service({ head: async () => ({ kind }) });
      expect(await heads.getSlackInstructionsHead(caller, AGENT)).toEqual({
        state: "unread",
        reason: kind,
      });
    }
  });

  test("GitHub failing or hanging is BACKEND_UNAVAILABLE", async () => {
    for (const options of [
      {
        head: async () => {
          throw new Error("GitHub getBranchHead failed (502)");
        },
      },
      { head: () => new Promise<never>(() => {}), timeoutMs: 5 },
    ]) {
      const { heads } = service(options);
      const failed = await heads
        .getSlackInstructionsHead(caller, AGENT)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(SessionServiceError);
      expect((failed as SessionServiceError).code).toBe("BACKEND_UNAVAILABLE");
    }
  });

  test("an agent the workspace does not have is NOT_FOUND, not unread", async () => {
    const { heads, reads } = service({ noAgent: true });
    const missing = await heads
      .getSlackInstructionsHead(caller, AGENT)
      .catch((error: unknown) => error);
    expect((missing as SessionServiceError).code).toBe("NOT_FOUND");
    expect(reads).toEqual([]);
  });

  test("a caller the policy refuses gets FORBIDDEN and GitHub is not read", async () => {
    const { heads, reads } = service({ allow: false });
    const refused = await heads
      .getSlackInstructionsHead(caller, AGENT)
      .catch((error: unknown) => error);
    expect((refused as SessionServiceError).code).toBe("FORBIDDEN");
    expect(reads).toEqual([]);
  });
});
