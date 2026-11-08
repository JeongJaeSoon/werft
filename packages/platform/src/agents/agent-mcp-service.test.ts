import { describe, expect, test } from "bun:test";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { AgentMcpStore } from "../ports/agent-mcp-store.ts";
import type { SessionCatalog } from "../sessions/catalog.ts";
import { createAgentMcpService } from "./agent-mcp-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const USER = "019a0000-0000-7000-8000-0000000000d1";

const catalog = {
  profiles: {},
  repositories: {},
  mcp_servers: {
    docs: { credential_ref: "docs-key", workspaces: ["acme"] },
    // Open to another workspace alone.
    elsewhere: { credential_ref: "docs-key", workspaces: ["other"] },
  },
} as unknown as SessionCatalog;

const owner = (surface: "web" | "api") =>
  callerFor(
    {
      kind: "user",
      id: USER,
      workspace_id: WORKSPACE,
      role: "owner",
      scopes: ["sessions:read", "sessions:write"],
    },
    { kind: surface },
    crypto.randomUUID(),
  );

type Put = Parameters<AgentMcpStore["put"]>[0];

const releaseNaming = (server: string | null) =>
  server === null
    ? null
    : {
        id: "rel_1",
        card: { capabilities: { mcp: [{ server }] } },
        policyPins: {},
      };

/**
 * `readServer` is the server of the release the service read before the
 * save; `lockedServer` the one the store reads under the agent's lock.
 */
function serviceWith(
  options: { readServer?: string | null; lockedServer?: string | null } = {},
) {
  const puts: Put[] = [];
  const store: AgentMcpStore = {
    agent: async () => ({
      workspaceSlug: "acme",
      activeRelease: releaseNaming(options.readServer ?? null),
    }),
    row: async () => null,
    boundRefs: async () => [],
    async put(input) {
      // Like the real store: a refusing check writes nothing.
      input.check(null, options.lockedServer ?? null);
      puts.push(input);
      return { outcome: "saved", revision: 1, receiptId: "receipt-1" };
    },
  };
  return {
    puts,
    service: createAgentMcpService({
      authorization: createAuthorizationPolicy(),
      store,
      catalog,
    }),
  };
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const failure = error as {
      code: string;
      details?: { reason_code?: string };
    };
    return `${failure.code}:${failure.details?.reason_code ?? ""}`;
  }
  return "saved";
};

const request = (settings: object) => ({
  expected_revision: null,
  settings: {
    server: "docs",
    allowed_tools: ["mcp__docs__read"],
    credential_refs: ["docs-key"],
    ...settings,
  },
});

describe("the agent MCP service", () => {
  test("only a signed-in console user saves: an API key never writes, so updated_by is always a person", async () => {
    const { service, puts } = serviceWith();
    expect(await refusal(service.put(owner("api"), AGENT, request({})))).toBe(
      "FORBIDDEN:web_session_required",
    );
    expect(puts).toHaveLength(0);
    await service.put(owner("web"), AGENT, request({}));
    expect(puts[0]?.userId).toBe(USER);
  });

  test("names reach the store sorted and once each", async () => {
    const { service, puts } = serviceWith();
    await service.put(
      owner("web"),
      AGENT,
      request({
        allowed_tools: ["mcp__docs__search", "mcp__docs__read"],
        credential_refs: ["docs-key", "a-key"],
      }),
    );
    expect(puts[0]?.settings).toEqual({
      server: "docs",
      allowed_tools: ["mcp__docs__read", "mcp__docs__search"],
      credential_refs: ["a-key", "docs-key"],
    });
  });

  test("a repeated credential name is refused before the store", async () => {
    const { service, puts } = serviceWith();
    expect(
      await refusal(
        service.put(
          owner("web"),
          AGENT,
          request({ credential_refs: ["docs-key", "docs-key"] }),
        ),
      ),
    ).toBe("BAD_REQUEST:duplicate");
    expect(puts).toHaveLength(0);
  });

  test("a server only another workspace may use is refused as unknown", async () => {
    const { service, puts } = serviceWith();
    expect(
      await refusal(
        service.put(
          owner("web"),
          AGENT,
          request({
            server: "elsewhere",
            allowed_tools: ["mcp__elsewhere__read"],
          }),
        ),
      ),
    ).toBe("BAD_REQUEST:server_unknown");
    expect(puts).toHaveLength(0);
  });

  test("a server gone from the catalog counts as kept only if the release under the lock names it", async () => {
    const save = (lockedServer: string) =>
      serviceWith({ readServer: "retired", lockedServer }).service.put(
        owner("web"),
        AGENT,
        request({
          server: "retired",
          allowed_tools: ["mcp__retired__read"],
        }),
      );
    // The release changed between the read and the lock: "retired" is new.
    expect(await refusal(save("wiki"))).toBe("BAD_REQUEST:server_unknown");
    // Still the active release's server: narrowing it stays possible.
    expect(await refusal(save("retired"))).toBe("saved");
  });

  test("the server's credential must be among the names", async () => {
    const { service } = serviceWith();
    expect(
      await refusal(
        service.put(owner("web"), AGENT, request({ credential_refs: [] })),
      ),
    ).toBe("BAD_REQUEST:server_credential_missing");
  });
});
