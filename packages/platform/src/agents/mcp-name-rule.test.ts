import { describe, expect, test } from "bun:test";
import {
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { AgentMcpStore } from "../ports/agent-mcp-store.ts";
import { effectiveMcp } from "../sessions/mcp-settings.ts";
import { createAgentMcpService } from "./agent-mcp-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USER = "019a0000-0000-7000-8000-0000000000c1";
const AGENT = "019a0000-0000-7000-8000-0000000000d1";

const caller = () => {
  const role: WorkspaceRole = "owner";
  const principal: Principal = {
    kind: "user",
    id: USER,
    workspace_id: WORKSPACE,
    role,
    scopes: [...scopesForRole(role)],
  };
  return callerFor(principal, { kind: "web" }, crypto.randomUUID());
};

function service(lockedDeny: string[] = []) {
  const store: AgentMcpStore = {
    agent: async () => ({ workspaceSlug: "acme", activeRelease: null }),
    row: async () => null,
    boundRefs: async () => [],
    async put(input) {
      input.check(null, null, lockedDeny);
      return { outcome: "saved", revision: 1, receiptId: null };
    },
  };
  return createAgentMcpService({
    authorization: createAuthorizationPolicy(),
    store,
    catalog: {
      mcp_servers: {
        docs: {
          url: "https://docs.invalid/",
          credential_ref: "docs-key",
          auth: { kind: "bearer" },
          workspaces: ["acme"],
        },
      } as never,
    },
  });
}

const allowed = async (name: string, lockedDeny: string[] = []) => {
  try {
    await service(lockedDeny).put(caller(), AGENT, {
      expected_revision: null,
      settings: {
        server: "docs",
        allowed_tools: [name],
        credential_refs: ["docs-key"],
      },
    });
    return true;
  } catch {
    return false;
  }
};

// The names of NAMES that are a whole tool of the listed server `docs`: the
// only ones a deny has anything to block for.
const BLOCKABLE = new Set([
  "mcp__docs__read",
  "mcp__docs__read:all",
  "mcp__docs__a__b",
  "mcp__docs__Bash(rm:*)",
]);
const blockable = (name: string) => BLOCKABLE.has(name);

const runs = (name: string, deny: string[]) =>
  effectiveMcp({
    start: null,
    row: null,
    release: { server: "docs", tools: [name], deny },
  }).tools.includes(name);

const NAMES = [
  "mcp__docs__read",
  "mcp__docs__read:all",
  "mcp__docs__a__b",
  "mcp__docs__Bash(rm:*)",
  "mcp__docs__",
  "mcp__docs__read all",
  "mcp__docs__tab\there",
  "mcp__docs__nul\u0000l",
  `mcp__docs__${"x".repeat(200)}`,
  "mcp__wiki__read",
  "docs__read",
];

describe("one rule for allowing, blocking and running an mcp__ name", () => {
  test("a name the agent's settings accept is a name a release's mcp_deny can block, and the reverse", async () => {
    for (const name of NAMES) {
      expect({ name, allowed: await allowed(name) }).toEqual({
        name,
        allowed: blockable(name) && name.startsWith("mcp__docs__"),
      });
    }
    // The pin the issue named: a `:` in the tool part is allowable.
    expect(await allowed("mcp__docs__read:all")).toBe(true);
  });

  test("an accepted name is exact for the run: its deny removes it, any other deny leaves it", () => {
    for (const name of NAMES.filter(blockable)) {
      expect(runs(name, [])).toBe(true);
      expect(runs(name, [name])).toBe(false);
      expect(runs(name, [`${name}x`, name.slice(0, -1)])).toBe(true);
    }
  });

  test("a deny just written but not yet rolled out does not stop the save, and still keeps the tool from running", async () => {
    const name = "mcp__docs__write";
    // The active release's snapshot has no deny yet, so the save passes...
    expect(await allowed(name, [])).toBe(true);
    // ...and the release that carries the deny runs without the tool.
    expect(runs(name, [name])).toBe(false);
    // Once the release carries it, the writer refuses to add it.
    expect(await allowed(name, [name])).toBe(false);
  });
});
