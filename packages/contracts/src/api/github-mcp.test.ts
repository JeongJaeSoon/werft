import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AgentGitHub } from "../kollegium/agents.ts";
import { runtimeConfigSchema } from "../worker-protocol/index.ts";
import {
  ACTION_REFUSAL_CODE_PATTERN,
  ACTION_REFUSAL_CODES,
} from "./action-broker.ts";
import {
  ACTION_CLASS_VALUES,
  type ActionClass,
  actionPolicyOf,
  GITHUB_MCP_FIXED_TOOLS,
  GITHUB_MCP_TOOL_ARGUMENTS,
  GITHUB_MCP_TOOL_CLASSES,
  GITHUB_MCP_TOOL_DESCRIPTIONS,
  GITHUB_MCP_TOOL_OUTPUTS,
  GITHUB_MCP_TOOL_REFUSALS,
  type GitHubMcpTool,
  githubMcpRefusalSpec,
  githubMcpToolNames,
  githubMcpTools,
  listedGitHubMcpTools,
  pushClassOf,
} from "./github-mcp.ts";
import { PULL_REQUEST_REFUSAL_VALUES } from "./pull-request.ts";
import { PUSH_REFUSAL_VALUES } from "./push-request.ts";

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

  test("a push is judged per repository: the session's own is primary, any other attached", () => {
    expect(pushClassOf("app", "app")).toBe("push.primary");
    expect(pushClassOf("app", "docs")).toBe("push.attached");
    expect(pushClassOf(null, "docs")).toBe("push.attached");
  });

  test("the policy per class is computed from the settings and the attached value", () => {
    expect(actionPolicyOf(settings({}), "ask")).toEqual({
      "push.primary": "ask",
      "push.attached": "ask",
      "pull_request.write": "allow",
      "pull_request.merge": "workspace_ceiling",
      review: "deny",
      workflow: "deny",
      "repository.read": "allow",
    });
    expect(
      actionPolicyOf(
        { ...settings({ review: true, actions: true }), push_approval: false },
        "deny",
      ),
    ).toMatchObject({
      "push.primary": "allow",
      "push.attached": "deny",
      review: "allow",
      workflow: "allow",
    });
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
