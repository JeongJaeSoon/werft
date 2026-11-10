import { describe, expect, test } from "bun:test";
import {
  type AgentGitHub,
  GITHUB_MCP_FIXED_TOOLS,
  githubMcpTools,
} from "@werft-ai/contracts";
import type { GitHubMcpSessionState } from "../ports/github-mcp.ts";
import { verifyGitHubMcpGrant } from "../sessions/github-mcp-server.ts";
import {
  createGitHubMcpEgress,
  GITHUB_MCP_UPSTREAM_PATH,
} from "./github-mcp-egress.ts";

const KEY = new Uint8Array(32).fill(3);
const NOW = 5_000;
const fenced = { sessionId: "sess-1", attemptId: "att-1" };
const settings: AgentGitHub = {
  repositories: ["app"],
  push_approval: true,
  features: {
    workflows: false,
    actions: false,
    checks: false,
    issues: false,
    review: true,
  },
  actions_allow: [],
};
const state: GitHubMcpSessionState = {
  ownerId: "owner-a",
  agentId: "agent-1",
  releaseId: "rel-1",
  source: "release",
  github: settings,
  enabled: true,
  actor: {
    principal: { kind: "api_key", id: "key-1" },
    actor_user_id: null,
    agent_id: "agent-1",
  },
};
const call = (tool: string | null, method: string | null = "tools/call") => ({
  server: "github",
  rpc: { method, tool },
  regrant: false,
});

function egress(current: Partial<GitHubMcpSessionState> | null = {}) {
  return createGitHubMcpEgress({
    store: {
      sessionState: async () =>
        current === null ? null : { ...state, ...current },
    },
    grantKey: KEY,
    now: () => NOW,
  });
}

describe("createGitHubMcpEgress", () => {
  test("grants the authorizer's own route with a grant for the fenced session", async () => {
    const decision = await egress()(fenced, call("submit_review"));
    expect(decision.kind).toBe("granted");
    if (decision.kind !== "granted") return;
    expect(decision.upstream.url).toBe(GITHUB_MCP_UPSTREAM_PATH);
    const [[name, value] = ["", ""]] = decision.upstream.headers;
    expect(name).toBe("authorization");
    expect(
      verifyGitHubMcpGrant(KEY, value.replace(/^Bearer /, ""), NOW),
    ).toEqual(fenced);
  });

  test("grants the handshake and a GET or DELETE", async () => {
    for (const request of [
      call(null, "initialize"),
      call(null, "tools/list"),
      call(null, "notifications/initialized"),
      call(null, null),
    ]) {
      expect((await egress()(fenced, request)).kind).toBe("granted");
    }
  });

  test("refuses a tool of a feature the release turned off", async () => {
    expect(await egress()(fenced, call("dispatch_workflow"))).toMatchObject({
      kind: "refused",
      status: 403,
      code: "FORBIDDEN",
    });
    expect(await egress()(fenced, call(null))).toMatchObject({
      kind: "refused",
    });
  });

  test("under the agent's settings passes every fixed tool on, switch off or feature off: the server refuses each call", async () => {
    for (const current of [
      { source: "agent" as const },
      { source: "agent" as const, enabled: false },
    ]) {
      for (const tool of GITHUB_MCP_FIXED_TOOLS) {
        expect((await egress(current)(fenced, call(tool))).kind).toBe(
          "granted",
        );
      }
      expect(await egress(current)(fenced, call("not_a_tool"))).toMatchObject({
        kind: "refused",
        status: 403,
      });
    }
  });

  test("refuses a method outside the tool surface", async () => {
    expect(await egress()(fenced, call(null, "resources/list"))).toMatchObject({
      kind: "refused",
      status: 403,
    });
  });

  test("refuses every exchange once the switch is off, the release carries no GitHub, or no one started the session", async () => {
    for (const current of [
      { enabled: false },
      { github: null },
      { actor: null },
      null,
    ]) {
      expect(
        await egress(current)(fenced, call(null, "initialize")),
      ).toMatchObject({ kind: "refused", status: 403 });
    }
  });
});

describe("saved mcp__github__ denies", () => {
  test("refuse a blocked tool and still grant the others", async () => {
    const blockedTools = ["submit_review"];
    const refused = await egress({ blockedTools })(
      fenced,
      call("submit_review"),
    );
    expect(refused.kind).toBe("refused");
    const other = githubMcpTools(settings).find(
      (tool) => tool !== "submit_review",
    );
    expect(other).toBeDefined();
    const granted = await egress({ blockedTools })(fenced, call(other ?? null));
    expect(granted.kind).toBe("granted");
  });

  test("a store that predates the field blocks nothing", async () => {
    expect((await egress()(fenced, call("submit_review"))).kind).toBe(
      "granted",
    );
  });
});
