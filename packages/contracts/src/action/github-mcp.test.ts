import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { PULL_REQUEST_REFUSAL_VALUES } from "../api/pull-request.ts";
import { PUSH_REFUSAL_VALUES } from "../api/push-request.ts";
import type { AgentGitHub } from "../kollegium/agents.ts";
import { runtimeConfigSchema } from "../worker-protocol/index.ts";
import {
  ACTION_REFUSAL_CODE_PATTERN,
  ACTION_REFUSAL_CODES,
} from "./action-broker.ts";
import {
  ACTION_CLASS_VALUES,
  type ActionClass,
  GITHUB_MCP_FIXED_TOOLS,
  GITHUB_MCP_REFUSAL_OVERRIDES,
  GITHUB_MCP_TOOL_ARGUMENTS,
  GITHUB_MCP_TOOL_CLASSES,
  GITHUB_MCP_TOOL_DESCRIPTIONS,
  GITHUB_MCP_TOOL_FEATURES,
  GITHUB_MCP_TOOL_OUTPUTS,
  GITHUB_MCP_TOOL_REFUSALS,
  GITHUB_MCP_TOOLS,
  type GitHubMcpTool,
  githubMcpRefusalSpec,
  githubMcpToolNames,
  githubMcpTools,
  LISTED_REPOSITORY_STATUS_VALUES,
  listedGitHubMcpTools,
  listedRepositorySchema,
  PUSH_CLASS_VALUES,
} from "./github-mcp.ts";

const off: AgentGitHub["features"] = {
  workflows: false,
  actions: false,
  checks: false,
  issues: false,
  review: false,
};
const settings = (features: Partial<AgentGitHub["features"]>): AgentGitHub => ({
  repositories: ["app"],
  push_approval: true,
  features: { ...off, ...features },
  actions_allow: [],
});

describe("the tool table", () => {
  // Pinned by name so that a row dropped from GITHUB_MCP_TOOLS fails here,
  // not only in the columns derived from it.
  const TOOL_NAMES = [
    "request_push",
    "open_pull_request",
    "get_push_request",
    "update_pull_request",
    "comment_pull_request",
    "close_pull_request",
    "reopen_pull_request",
    "merge_pull_request",
    "dispatch_workflow",
    "get_workflow_run",
    "rerun_workflow",
    "submit_review",
    "list_repositories",
    "attach_repository",
  ];

  test("holds exactly the shipped tools, and every column covers each row", () => {
    expect(Object.keys(GITHUB_MCP_TOOLS)).toEqual(TOOL_NAMES);
    for (const column of [
      GITHUB_MCP_TOOL_ARGUMENTS,
      GITHUB_MCP_TOOL_FEATURES,
      GITHUB_MCP_TOOL_CLASSES,
      GITHUB_MCP_TOOL_DESCRIPTIONS,
      GITHUB_MCP_TOOL_OUTPUTS,
      GITHUB_MCP_TOOL_REFUSALS,
    ]) {
      expect(Object.keys(column)).toEqual(TOOL_NAMES);
    }
    expect([...GITHUB_MCP_FIXED_TOOLS] as string[]).toEqual(TOOL_NAMES);
  });

  test("keeps each refusal override on the tool that had it", () => {
    expect(
      Object.fromEntries(
        Object.entries(GITHUB_MCP_REFUSAL_OVERRIDES).map(
          ([tool, overrides]) => [tool, Object.keys(overrides ?? {})],
        ),
      ),
    ).toEqual({
      open_pull_request: ["push_failed"],
      update_pull_request: ["push_failed"],
      comment_pull_request: ["push_failed"],
      close_pull_request: ["push_failed", "forge_failed"],
      reopen_pull_request: ["push_failed", "forge_failed"],
      merge_pull_request: ["push_failed"],
    });
  });

  test("keeps a refusal override only on a row that lists the code", () => {
    for (const [tool, overrides] of Object.entries(
      GITHUB_MCP_REFUSAL_OVERRIDES,
    )) {
      expect(TOOL_NAMES).toContain(tool);
      const listed: readonly string[] =
        GITHUB_MCP_TOOL_REFUSALS[tool as GitHubMcpTool];
      for (const code of Object.keys(overrides)) {
        expect(listed).toContain(code);
      }
    }
  });
});

describe("the action class every tool carries", () => {
  test("every tool has a class, and no class is administration", () => {
    const tools = Object.keys(GITHUB_MCP_TOOL_ARGUMENTS) as GitHubMcpTool[];
    expect(Object.keys(GITHUB_MCP_TOOL_CLASSES).sort()).toEqual(
      [...tools].sort(),
    );
    for (const tool of tools) {
      expect(ACTION_CLASS_VALUES).toContain(GITHUB_MCP_TOOL_CLASSES[tool]);
    }
    expect(ACTION_CLASS_VALUES as readonly string[]).not.toContain(
      "administration",
    );
  });

  test("a tool without a class does not typecheck", () => {
    const { request_push: _left, ...rest } = GITHUB_MCP_TOOL_CLASSES;
    // @ts-expect-error `request_push` has no class in `rest`
    const incomplete: Record<GitHubMcpTool, ActionClass> = rest;
    expect(incomplete.request_push).toBeUndefined();
  });

  test("a name with no class, or a class this image does not know, is not listed", () => {
    const names = [...Object.keys(GITHUB_MCP_TOOL_ARGUMENTS), "mystery_tool"];
    // The real table lists every real tool and drops the one it never named.
    expect(listedGitHubMcpTools(names)).toEqual(
      Object.keys(GITHUB_MCP_TOOL_ARGUMENTS) as GitHubMcpTool[],
    );
    // Without request_push's class the tool vanishes from the list.
    const { request_push: _left, ...without } = GITHUB_MCP_TOOL_CLASSES;
    expect(listedGitHubMcpTools(names, without)).not.toContain("request_push");
    expect(
      listedGitHubMcpTools(["request_push"], {
        request_push: "administration" as ActionClass,
      }),
    ).toEqual([]);
    // A name that is an Object.prototype key is not a tool either.
    expect(listedGitHubMcpTools(["constructor", "toString"])).toEqual([]);
  });

  test("the fixed list and the per-release list are built from the classified tools only", () => {
    expect([...GITHUB_MCP_FIXED_TOOLS].sort()).toEqual(
      (Object.keys(GITHUB_MCP_TOOL_CLASSES) as GitHubMcpTool[]).sort(),
    );
    for (const tool of githubMcpTools(settings({ actions: true }))) {
      expect(GITHUB_MCP_TOOL_CLASSES[tool]).toBeDefined();
    }
  });

  test("the stored push classes still parse, so an older row is read", () => {
    expect(PUSH_CLASS_VALUES).toEqual([
      "push",
      "push.primary",
      "push.attached",
    ]);
  });
});

describe("githubMcpTools", () => {
  test("exposes the default work always and a feature's tools only when it is on", () => {
    expect(githubMcpTools(settings({}))).toEqual([
      "request_push",
      "open_pull_request",
      "get_push_request",
      "update_pull_request",
      "comment_pull_request",
      "close_pull_request",
      "reopen_pull_request",
      "merge_pull_request",
      "list_repositories",
      "attach_repository",
    ]);
    expect(
      githubMcpTools(settings({ workflows: true, checks: true, issues: true })),
    ).toEqual([
      "request_push",
      "open_pull_request",
      "get_push_request",
      "update_pull_request",
      "comment_pull_request",
      "close_pull_request",
      "reopen_pull_request",
      "merge_pull_request",
      "list_repositories",
      "attach_repository",
    ]);
    expect<string[]>(
      githubMcpTools(settings({ actions: true, review: true })),
    ).toEqual(Object.keys(GITHUB_MCP_TOOL_ARGUMENTS));
    expect(
      githubMcpToolNames(githubMcpTools(settings({ review: true }))),
    ).toContain("mcp__github__submit_review");
    expect(GITHUB_MCP_FIXED_TOOLS).toEqual(
      Object.keys(GITHUB_MCP_TOOL_ARGUMENTS) as GitHubMcpTool[],
    );
  });

  test("no tool's arguments take a session id", () => {
    for (const schema of Object.values(GITHUB_MCP_TOOL_ARGUMENTS)) {
      expect(
        schema.safeParse({
          session_id: "11111111-1111-4111-8111-111111111111",
        }).success,
      ).toBe(false);
    }
  });
});

describe("the refusal code tables", () => {
  const tools = Object.keys(GITHUB_MCP_TOOL_ARGUMENTS) as GitHubMcpTool[];

  test("every listed code has a row, in the code shape, and each tool lists no code twice", () => {
    for (const tool of tools) {
      const listed = GITHUB_MCP_TOOL_REFUSALS[tool];
      expect(new Set(listed).size).toBe(listed.length);
      for (const code of listed) {
        expect(code).toMatch(ACTION_REFUSAL_CODE_PATTERN);
        expect(ACTION_REFUSAL_CODES).toHaveProperty(code);
      }
    }
  });

  test("the push and pull request refusals that exist today keep their names in the table", () => {
    for (const value of [
      ...PUSH_REFUSAL_VALUES,
      ...PULL_REQUEST_REFUSAL_VALUES,
    ]) {
      expect(ACTION_REFUSAL_CODES).toHaveProperty(value);
    }
  });

  test("by and retryable are fixed per code (catalog 5.5 to 5.7)", () => {
    expect(githubMcpRefusalSpec("request_push", "no_repository")).toEqual({
      by: "policy",
      retryable: false,
    });
    expect(githubMcpRefusalSpec("request_push", "request_open")).toEqual({
      by: "platform",
      retryable: true,
    });
    expect(githubMcpRefusalSpec("open_pull_request", "push_rejected")).toEqual({
      by: "person",
      retryable: false,
    });
    expect(githubMcpRefusalSpec("open_pull_request", "forge_failed")).toEqual({
      by: "github",
      retryable: true,
    });
    // Close and reopen cannot tell an outage from a final refusal.
    expect(githubMcpRefusalSpec("close_pull_request", "forge_failed")).toEqual({
      by: "github",
      retryable: false,
    });
    // The pull request tools read a failed push as final.
    expect(githubMcpRefusalSpec("request_push", "push_failed")).toBeNull();
    expect(githubMcpRefusalSpec("open_pull_request", "push_failed")).toEqual({
      by: "platform",
      retryable: false,
    });
    expect(
      githubMcpRefusalSpec("close_pull_request", "pull_request_merged"),
    ).toEqual({
      by: "platform",
      retryable: false,
    });
    expect(
      githubMcpRefusalSpec("attach_repository", "repository_not_allowed"),
    ).toEqual({
      by: "policy",
      retryable: false,
    });
    expect(
      githubMcpRefusalSpec("list_repositories", "no_such_code"),
    ).toBeNull();
  });
});

describe("the tool envelope", () => {
  test("every tool has an output schema, and a refusal carries no message", () => {
    for (const tool of Object.keys(
      GITHUB_MCP_TOOL_ARGUMENTS,
    ) as GitHubMcpTool[]) {
      const schema = GITHUB_MCP_TOOL_OUTPUTS[tool];
      expect(
        schema.safeParse({
          ok: false,
          refusal: { code: "not_found", by: "platform", retryable: false },
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({
          ok: false,
          refusal: {
            code: "not_found",
            by: "platform",
            retryable: false,
            message: "x",
          },
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ok: false,
          refusal: { code: "Not Found", by: "platform", retryable: false },
        }).success,
      ).toBe(false);
      expect(() =>
        z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }),
      ).not.toThrow();
    }
  });

  test("a tool description names fields and effects, and gives the model no orders", () => {
    for (const description of Object.values(GITHUB_MCP_TOOL_DESCRIPTIONS)) {
      expect(description).not.toMatch(
        /\b(you|your|do not|don't|must|should|tell the user|end (this|your) turn|call (it|this|open_pull_request)|instructions?)\b/i,
      );
    }
  });

  test("the repository tools speak of attached and not_attached, never of a primary, an available or a default repository", () => {
    for (const tool of ["list_repositories", "attach_repository"] as const) {
      expect(GITHUB_MCP_TOOL_DESCRIPTIONS[tool]).not.toMatch(
        /\b(primary|available|default repository)\b/i,
      );
    }
  });

  // Lead decision 3 (2026-11-09): the one purpose sentence the "fields and
  // effects" rule allows, pinned here so it is not dropped by accident. The
  // word list above stays as it was.
  test("attach_repository says what it is for, what a new attach records and how a transient failure differs from a refusal", () => {
    const attach = GITHUB_MCP_TOOL_DESCRIPTIONS.attach_repository;
    expect(attach).toContain(
      "It is meant for a repository whose code the task reads or changes",
    );
    // A purpose, not a rule about which repositories to leave alone.
    expect(attach).not.toContain("stay unattached");
    expect(attach).toContain(
      "A new attach is recorded on the session; a repository already attached, or the session's own, is answered as attached with nothing new recorded.",
    );
    expect(attach).toContain(
      "A failure that comes from the connection (an `upstream connection failed` answer, or HTTP 502 or 503) is transient and says nothing about the repository; `repository_not_allowed` is a refusal by the agent's settings, not a connection failure.",
    );
    // It says nothing it cannot know: whether a remote exists, or what a
    // repeated refusal returns.
    expect(attach).not.toMatch(/same answer|has been given|exists/i);
  });

  // 94S-1479: the fetch leaves no working tree, so a model that attached
  // a repository and then looked for files with Read or Glob found nothing,
  // and one without Bash had no way to read it at all.
  test("attach_repository says the fetch leaves no working tree, how Bash reads it, and that a session without Bash cannot", () => {
    const attach = GITHUB_MCP_TOOL_DESCRIPTIONS.attach_repository;
    expect(attach).toContain("no working tree");
    expect(attach).toContain("Read, Glob and Grep cannot see");
    expect(attach).toContain("git ls-tree -r <repository_id>/<branch>");
    expect(attach).toContain("git show <repository_id>/<branch>:<path>");
    expect(attach).toContain("git grep <pattern> <repository_id>/<branch>");
    expect(attach).toContain(
      "without Bash can attach a repository but cannot read it",
    );
  });

  test("list_repositories names the statuses it answers and the remote it reports", () => {
    const list = GITHUB_MCP_TOOL_DESCRIPTIONS.list_repositories;
    for (const word of [
      "`attached`",
      "`pending`",
      "`failed`",
      "`not_attached`",
      "`allowed_in_newer_release`",
      "`remote`",
      "`origin`",
    ]) {
      expect(list).toContain(word);
    }
    expect(list).not.toMatch(/not counted|comes first/i);
    expect(list).not.toMatch(/in the workspace|without the remote/i);
  });
});

describe("listedRepositorySchema", () => {
  const entry = { id: "web", name: "acme/web", branch: "main" };

  test("keeps every status and entry shape from before, and adds not_attached, revoked and remote", () => {
    for (const status of [
      "primary",
      "attached",
      "pending",
      "failed",
      "available",
      "allowed_in_newer_release",
    ]) {
      expect(
        listedRepositorySchema.safeParse({ ...entry, status }).success,
      ).toBe(true);
    }
    expect([...LISTED_REPOSITORY_STATUS_VALUES].slice(0, 6)).toEqual([
      "primary",
      "attached",
      "pending",
      "failed",
      "available",
      "allowed_in_newer_release",
    ]);
    for (const status of ["not_attached", "revoked"]) {
      expect(
        listedRepositorySchema.safeParse({ ...entry, status }).success,
      ).toBe(true);
    }
    expect(
      listedRepositorySchema.parse({
        ...entry,
        status: "attached",
        remote: "origin",
      }),
    ).toEqual({ ...entry, status: "attached", remote: "origin" });
    // Absent unless the repository is attached; never an empty name.
    expect(
      "remote" in
        listedRepositorySchema.parse({ ...entry, status: "attached" }),
    ).toBe(false);
    expect(
      listedRepositorySchema.safeParse({
        ...entry,
        status: "attached",
        remote: "",
      }).success,
    ).toBe(false);
    expect(
      listedRepositorySchema.safeParse({ ...entry, status: "unknown" }).success,
    ).toBe(false);
  });
});

describe("runtime config mcp_servers", () => {
  const server = (name: string) => ({
    name,
    endpoint: "https://builtin.invalid/mcp/github",
    binding: `sha256:${"0".repeat(64)}`,
    access: { kind: "egress_token", token: "wem_x" },
  });
  const servers = runtimeConfigSchema.shape.mcp_servers;

  test("carries a catalog server and the built-in one, never the same twice", () => {
    expect(servers.safeParse([server("fake"), server("github")]).success).toBe(
      true,
    );
    expect(
      servers.safeParse([server("github"), server("github")]).success,
    ).toBe(false);
    expect(
      servers.safeParse([server("a"), server("b"), server("c")]).success,
    ).toBe(false);
  });
});
