import { describe, expect, test } from "bun:test";
import {
  scopesForRole,
  type WorkspaceRole,
  workspaceMcpServerListSchema,
} from "@werft-ai/contracts";
import { userPrincipal } from "@werft-ai/testkit/callers";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import { SessionServiceError } from "../musterrolle/service-errors.ts";
import {
  FAKE_ISSUER,
  FAKE_MCP_URL,
  type FakeRemoteOptions,
  fakeRemote,
  memoryWorkspaceMcpStore,
} from "../testing/workspace-mcp-fakes.ts";
import type { OutboundRequest } from "./ports/workspace-mcp-store.ts";
import { createWorkspaceMcpService } from "./service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";
const ADMIN = "019a0000-0000-7000-8000-0000000000a2";
const MEMBER = "019a0000-0000-7000-8000-0000000000a3";
const KEY = "019a0000-0000-7000-8000-0000000000e1";
const FAKE_TOKEN = "example-token-not-real";

function user(id: string, role: WorkspaceRole): Caller {
  return callerFor(
    userPrincipal(id, WORKSPACE, role),
    { kind: "web" },
    crypto.randomUUID(),
  );
}
const owner = user(OWNER, "owner");
const admin = user(ADMIN, "admin");
const member = user(MEMBER, "member");
const ownerKey = callerFor(
  {
    kind: "api_key",
    id: KEY,
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopesForRole("owner")],
  },
  { kind: "api" },
  crypto.randomUUID(),
  { creatorId: OWNER },
);

function setup(
  options: {
    remote?: FakeRemoteOptions;
    secretStoreOn?: boolean;
    redirect?: boolean;
    urlProblem?: string | null;
    addressProblem?: "address_not_allowed" | "unreachable" | null;
    /** Runs before each outbound request reaches the fake, to change things mid-call. */
    beforeSend?: (request: OutboundRequest) => Promise<void> | void;
  } = {},
) {
  let clock = new Date("2026-11-15T00:00:00.000Z");
  let ids = 0;
  const remote = fakeRemote(options.remote);
  const addressAsked: string[] = [];
  const memory = memoryWorkspaceMcpStore(
    { [ADMIN]: "Admin", [OWNER]: "Owner" },
    () => clock,
  );
  const service = createWorkspaceMcpService({
    authorization: createAuthorizationPolicy(),
    store: memory.store,
    secretStoreOn: options.secretStoreOn ?? true,
    remote: {
      http: async (request) => {
        await options.beforeSend?.(request);
        return remote.http(request);
      },
      allowsUrl: remote.allowsUrl,
    },
    serverUrlProblem: () => options.urlProblem ?? null,
    serverAddressProblem: async (url) => {
      addressAsked.push(url);
      return options.addressProblem ?? null;
    },
    redirectUriFor: (id) =>
      options.redirect === false
        ? null
        : `https://console.example.com/settings/workspace/mcp-servers/${id}/callback`,
    now: () => clock,
    newId: () => {
      ids += 1;
      return `019a0000-0000-7000-8000-${String(ids).padStart(12, "0")}`;
    },
  });
  return {
    service,
    remote,
    memory,
    addressAsked,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      const details = error.details as { reason_code?: string } | null;
      return { code: error.code, reason: details?.reason_code };
    }
    throw error;
  }
  throw new Error("answered normally");
}

const oauthBody = {
  name: "tracker",
  url: FAKE_MCP_URL,
  auth_kind: "oauth" as const,
};

/** Registers an OAuth server and runs start → callback; returns the start answer's URL. */
async function connected(context: ReturnType<typeof setup>, caller = admin) {
  const created = await context.service.create(caller, oauthBody);
  const started = await context.service.startOAuth(caller, created.id);
  const url = new URL(started.authorization_url);
  const state = url.searchParams.get("state") ?? "";
  const server = await context.service.completeOAuth(caller, created.id, {
    code: "example-code",
    state,
    iss: FAKE_ISSUER,
  });
  return { created, url, state, server };
}

describe("who may change workspace MCP servers", () => {
  test("a member reads but does not register; a key never does", async () => {
    const { service } = setup();
    expect((await service.list(member)).items).toEqual([]);
    expect(await refusal(service.discover(member, FAKE_MCP_URL))).toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );
    expect(await refusal(service.create(ownerKey, oauthBody))).toMatchObject({
      code: "FORBIDDEN",
    });
  });

  test("without the secret store nothing can be registered", async () => {
    const { service } = setup({ secretStoreOn: false });
    expect(await refusal(service.create(admin, oauthBody))).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    });
  });

  test("a URL the installation refuses, one with a user name and a reserved name", async () => {
    expect(
      await refusal(
        setup({ urlProblem: "host_not_allowed" }).service.create(
          admin,
          oauthBody,
        ),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "host_not_allowed" });
    const { service, remote } = setup();
    expect(
      await refusal(
        service.create(admin, {
          ...oauthBody,
          url: "https://u:p@mcp.example.com/v1/mcp",
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "url_invalid" });
    for (const name of ["github", "browser", "memory", "werft"]) {
      expect(
        await refusal(service.create(admin, { ...oauthBody, name })),
      ).toEqual({
        code: "BAD_REQUEST",
        reason: "name_reserved",
      });
    }
    expect(remote.requests).toHaveLength(0);
  });
});

describe("OAuth", () => {
  test("discovery reads the challenge, the resource and the authorization server", async () => {
    const { service } = setup();
    expect(await service.discover(admin, FAKE_MCP_URL)).toEqual({
      url: FAKE_MCP_URL,
      oauth: {
        issuer: FAKE_ISSUER,
        scopes_supported: ["read:issues", "write:issues"],
        default_scope: "read:issues",
        dcr_supported: true,
      },
    });
  });

  test("start registers a client by DCR and sends the browser with PKCE and the resource", async () => {
    const context = setup();
    const created = await context.service.create(admin, oauthBody);
    expect(created.connection.state).toBe("none");
    const started = await context.service.startOAuth(admin, created.id);
    const url = new URL(started.authorization_url);
    expect(url.origin + url.pathname).toBe(`${FAKE_ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "fake-dcr-client",
      redirect_uri: `https://console.example.com/settings/workspace/mcp-servers/${created.id}/callback`,
      code_challenge_method: "S256",
      resource: FAKE_MCP_URL,
      scope: "read:issues",
    });
    expect(started.expires_at).toBe("2026-11-15T00:10:00.000Z");
    const registration = context.remote.requests.find((r) =>
      r.url.endsWith("/register"),
    );
    expect(JSON.parse(registration?.body ?? "{}")).toMatchObject({
      redirect_uris: [url.searchParams.get("redirect_uri")],
      token_endpoint_auth_method: "none",
    });
  });

  test("the callback stores the tokens under the person who signed in and reads the tools", async () => {
    const context = setup();
    const { server, url } = await connected(context);
    expect(server.connection).toMatchObject({
      state: "active",
      connected_by: { user_id: ADMIN, display_name: "Admin" },
      granted_scope: "read:issues",
    });
    expect(server.tools).toEqual([
      { name: "search_issues", description: "Find issues" },
    ]);
    const exchange = context.remote.requests.find(
      (r) => r.url.endsWith("/token") && r.body?.includes("authorization_code"),
    );
    const form = new URLSearchParams(exchange?.body ?? "");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get("resource")).toBe(FAKE_MCP_URL);
    expect(form.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
    expect(JSON.stringify(server)).not.toContain("fake-access-");
    expect(JSON.stringify(server)).not.toContain("fake-refresh-");
  });

  test("a callback that is not the flow in progress stores nothing", async () => {
    const context = setup();
    const created = await context.service.create(admin, oauthBody);
    const started = await context.service.startOAuth(admin, created.id);
    const state =
      new URL(started.authorization_url).searchParams.get("state") ?? "";
    const complete = (caller: Caller, body: { state: string; iss?: string }) =>
      refusal(
        context.service.completeOAuth(caller, created.id, {
          code: "example-code",
          ...body,
        }),
      );
    expect(
      await complete(admin, { state: "not-the-state", iss: FAKE_ISSUER }),
    ).toEqual({
      code: "BAD_REQUEST",
      reason: "oauth_state_invalid",
    });
    expect(await complete(owner, { state, iss: FAKE_ISSUER })).toEqual({
      code: "FORBIDDEN",
      reason: "oauth_flow_other_user",
    });
    expect(
      await complete(admin, { state, iss: "https://other.example.com" }),
    ).toEqual({
      code: "BAD_REQUEST",
      reason: "issuer_mismatch",
    });
    // The server says it sends `iss`, so a callback without one is refused.
    expect(await complete(admin, { state })).toEqual({
      code: "BAD_REQUEST",
      reason: "issuer_mismatch",
    });
    context.advance(10 * 60 * 1000);
    expect(await complete(admin, { state, iss: FAKE_ISSUER })).toEqual({
      code: "BAD_REQUEST",
      reason: "oauth_flow_expired",
    });
    expect(context.remote.requests.some((r) => r.url.endsWith("/token"))).toBe(
      false,
    );
    expect((await context.service.list(admin)).items[0]?.connection.state).toBe(
      "none",
    );
  });

  test("a grant wider than asked for is revoked and not stored", async () => {
    const context = setup({
      remote: {
        token: () => ({
          status: 200,
          json: {
            access_token: "fake-wide",
            token_type: "Bearer",
            refresh_token: "fake-wide-refresh",
            scope: "read:issues admin",
          },
        }),
      },
    });
    expect(await refusal(connected(context))).toEqual({
      code: "BAD_REQUEST",
      reason: "scope_widened",
    });
    expect(context.remote.revoked).toEqual(["fake-wide-refresh"]);
    expect(
      context.memory.stored(`019a0000-0000-7000-8000-000000000001`)?.access,
    ).toBeNull();
  });

  test("a token endpoint that sends the code back is refused without its body", async () => {
    const context = setup({
      remote: {
        token: (form) => ({
          status: 400,
          json: { error: "invalid_grant", echo: form.get("code") },
        }),
      },
    });
    expect(await refusal(connected(context))).toEqual({
      code: "BAD_REQUEST",
      reason: "credential_reflected",
    });
  });

  test("a refused code keeps the OAuth error code only", async () => {
    const context = setup({
      remote: {
        token: () => ({ status: 400, json: { error: "invalid_grant" } }),
      },
    });
    const created = await context.service.create(admin, oauthBody);
    const started = await context.service.startOAuth(admin, created.id);
    const state =
      new URL(started.authorization_url).searchParams.get("state") ?? "";
    try {
      await context.service.completeOAuth(admin, created.id, {
        code: "example-code",
        state,
        iss: FAKE_ISSUER,
      });
      throw new Error("answered normally");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionServiceError);
      expect((error as SessionServiceError).details).toEqual({
        reason_code: "token_rejected",
        oauth_error: "invalid_grant",
      });
    }
  });

  test("start needs the console origin, and a client when the server has no DCR", async () => {
    const noOrigin = setup({ redirect: false });
    const created = await noOrigin.service.create(admin, oauthBody);
    expect(
      await refusal(noOrigin.service.startOAuth(admin, created.id)),
    ).toEqual({
      code: "BACKEND_UNAVAILABLE",
      reason: "console_origin_unset",
    });
    const noDcr = setup({
      remote: { metadata: { registration_endpoint: undefined } },
    });
    const manual = await noDcr.service.create(admin, oauthBody);
    expect(manual.oauth?.dcr_supported).toBe(false);
    expect(await refusal(noDcr.service.startOAuth(admin, manual.id))).toEqual({
      code: "BAD_REQUEST",
      reason: "client_registration_required",
    });
    const set = await noDcr.service.putOAuthClient(admin, manual.id, {
      client_id: "hand-made",
    });
    expect(set.oauth).toMatchObject({
      client_registration: "manual",
      client_id: "hand-made",
    });
    const started = await noDcr.service.startOAuth(admin, manual.id);
    expect(
      new URL(started.authorization_url).searchParams.get("client_id"),
    ).toBe("hand-made");
  });

  test("a client that lands while DCR runs is kept, and the start asks again", async () => {
    let serverId = "";
    const context = setup({
      beforeSend: async (request) => {
        if (!request.url.endsWith("/register")) return;
        await context.service.putOAuthClient(owner, serverId, {
          client_id: "hand-made",
        });
      },
    });
    const created = await context.service.create(admin, oauthBody);
    serverId = created.id;
    expect(
      await refusal(context.service.startOAuth(admin, created.id)),
    ).toEqual({ code: "BAD_REQUEST", reason: "connection_changed" });
    expect((await context.service.list(admin)).items[0]?.oauth).toMatchObject({
      client_registration: "manual",
      client_id: "hand-made",
    });
  });

  test("an exchange that runs past the sign-in's expiry stores nothing and revokes what came", async () => {
    const context = setup({
      beforeSend: (request) => {
        if (
          request.url.endsWith("/token") &&
          request.body?.includes("authorization_code")
        ) {
          context.advance(10 * 60 * 1000);
        }
      },
    });
    expect(await refusal(connected(context))).toEqual({
      code: "BAD_REQUEST",
      reason: "oauth_state_invalid",
    });
    expect(context.remote.revoked).toHaveLength(1);
    expect((await context.service.list(admin)).items[0]?.connection.state).toBe(
      "none",
    );
  });

  test("disconnect deletes the tokens and revokes the refresh token", async () => {
    const context = setup();
    const { created } = await connected(context);
    const result = await context.service.disconnect(admin, created.id);
    expect(result.revoked).toBe(true);
    expect(result.server.connection.state).toBe("none");
    expect(context.remote.revoked).toEqual(["fake-refresh-1"]);
    expect(
      await context.service.credentialFor(WORKSPACE, created.id),
    ).toBeNull();
    expect(
      await refusal(context.service.refreshTools(admin, created.id)),
    ).toEqual({
      code: "BAD_REQUEST",
      reason: "not_connected",
    });
  });
});

describe("refresh", () => {
  test("an access token about to expire is refreshed once under the lock", async () => {
    const context = setup();
    const { created } = await connected(context);
    expect(
      await context.service.credentialFor(WORKSPACE, created.id),
    ).toMatchObject({
      accessToken: "fake-access-1",
    });
    context.advance(3600 * 1000 - 30_000);
    expect(
      await context.service.credentialFor(WORKSPACE, created.id),
    ).toMatchObject({
      accessToken: "fake-access-2",
    });
    const refreshes = context.remote.requests.filter((r) =>
      r.body?.includes("grant_type=refresh_token"),
    );
    expect(refreshes).toHaveLength(1);
    expect(new URLSearchParams(refreshes[0]?.body).get("refresh_token")).toBe(
      "fake-refresh-1",
    );
  });

  test("invalid_grant asks for a new sign-in; a network failure backs off", async () => {
    let answer = { status: 400, json: { error: "invalid_grant" } as unknown };
    let first = true;
    const context = setup({
      remote: {
        token: () => {
          if (first) {
            first = false;
            return {
              status: 200,
              json: {
                access_token: "fake-access-1",
                token_type: "Bearer",
                refresh_token: "fake-refresh-1",
                expires_in: 3600,
              },
            };
          }
          return answer;
        },
      },
    });
    const { created } = await connected(context);
    context.advance(3600 * 1000 - 30_000);
    answer = { status: 400, json: { error: "temporarily_unavailable" } };
    expect(
      await context.service.credentialFor(WORKSPACE, created.id),
    ).toMatchObject({
      accessToken: "fake-access-1",
    });
    expect(
      context.memory.stored(created.id)?.record.connection.refreshFailedAt,
    ).not.toBeNull();
    answer = { status: 400, json: { error: "invalid_grant" } };
    context.advance(31_000);
    expect(
      await context.service.credentialFor(WORKSPACE, created.id),
    ).toBeNull();
    expect(
      (await context.service.list(admin)).items[0]?.connection,
    ).toMatchObject({
      state: "needs_reauth",
      reauth_reason: "invalid_grant",
    });
  });

  test("waiting out a failed refresh does not push the retry back", async () => {
    let first = true;
    const context = setup({
      remote: {
        token: () => {
          if (!first) {
            return { status: 400, json: { error: "temporarily_unavailable" } };
          }
          first = false;
          return {
            status: 200,
            json: {
              access_token: "example-access-1",
              token_type: "Bearer",
              refresh_token: "example-refresh-1",
              expires_in: 3600,
            },
          };
        },
      },
    });
    const { created } = await connected(context);
    const refreshes = () =>
      context.remote.requests.filter((r) =>
        r.body?.includes("grant_type=refresh_token"),
      ).length;
    context.advance(3600 * 1000 - 40_000);
    await context.service.credentialFor(WORKSPACE, created.id);
    expect(refreshes()).toBe(1);
    context.advance(20_000);
    await context.service.credentialFor(WORKSPACE, created.id);
    expect(refreshes()).toBe(1);
    context.advance(10_000);
    await context.service.credentialFor(WORKSPACE, created.id);
    expect(refreshes()).toBe(2);
  });
});

describe("static token", () => {
  test("registers under the caller, reads tools, and answers only the last four", async () => {
    const context = setup({
      remote: {
        oauth: false,
        accepted: [FAKE_TOKEN],
        sse: true,
        toolPages: [
          [{ name: "search_issues" }, { name: "bad name!" }],
          [{ name: "create_issue", description: "x".repeat(2000) }],
        ],
      },
    });
    const created = await context.service.create(admin, {
      name: "tracker",
      url: FAKE_MCP_URL,
      auth_kind: "bearer",
      token: FAKE_TOKEN,
    });
    expect(created.bearer).toEqual({ last4: "real" });
    expect(created.connection.connected_by?.user_id).toBe(ADMIN);
    expect(created.tools.map((tool) => tool.name)).toEqual([
      "search_issues",
      "create_issue",
    ]);
    expect(created.tools[1]?.description).toHaveLength(1024);
    expect(created.tools_skipped).toBe(1);
    expect(JSON.stringify(created)).not.toContain(FAKE_TOKEN);
    const listCall = context.remote.requests.find((r) =>
      r.body?.includes("tools/list"),
    );
    expect(listCall?.headers).toMatchObject({
      Authorization: `Bearer ${FAKE_TOKEN}`,
      "Mcp-Session-Id": "fake-session",
      "MCP-Protocol-Version": "2025-06-18",
    });
  });

  test("a server that rejects the token leaves the tools empty; refreshTools says so", async () => {
    const context = setup({ remote: { oauth: false } });
    const created = await context.service.create(admin, {
      name: "tracker",
      url: FAKE_MCP_URL,
      auth_kind: "bearer",
      token: FAKE_TOKEN,
    });
    expect(created.tools).toEqual([]);
    expect(
      await refusal(context.service.refreshTools(admin, created.id)),
    ).toEqual({
      code: "BAD_REQUEST",
      reason: "unauthorized",
    });
  });

  test("a tool list read while the token was replaced, or by someone no longer managing, is not stored", async () => {
    let serverId = "";
    let swap = false;
    let drop = false;
    const context = setup({
      remote: { oauth: false, accepted: [FAKE_TOKEN] },
      beforeSend: async (request) => {
        if (!request.body?.includes("tools/list")) return;
        if (swap) {
          swap = false;
          await context.service.putBearerToken(owner, serverId, {
            token: FAKE_TOKEN,
          });
        }
        if (drop) {
          drop = false;
          context.memory.inactive.add(ADMIN);
        }
      },
    });
    const created = await context.service.create(admin, {
      name: "tracker",
      url: FAKE_MCP_URL,
      auth_kind: "bearer",
      token: FAKE_TOKEN,
    });
    serverId = created.id;
    swap = true;
    expect(
      await refusal(context.service.refreshTools(admin, created.id)),
    ).toEqual({ code: "BAD_REQUEST", reason: "connection_changed" });
    drop = true;
    expect(
      await refusal(context.service.refreshTools(admin, created.id)),
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  test("a second server of the same name, and a member no longer managing", async () => {
    const context = setup({ remote: { oauth: false } });
    const body = {
      name: "tracker",
      url: FAKE_MCP_URL,
      auth_kind: "bearer" as const,
      token: FAKE_TOKEN,
    };
    await context.service.create(admin, body);
    expect(await refusal(context.service.create(admin, body))).toEqual({
      code: "ALREADY_EXISTS",
      reason: "name_taken",
    });
    context.memory.inactive.add(ADMIN);
    expect(
      await refusal(context.service.create(admin, { ...body, name: "other" })),
    ).toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("the address check before a server is stored", () => {
  const bearerBody = {
    name: "tracker",
    url: FAKE_MCP_URL,
    auth_kind: "bearer" as const,
    token: FAKE_TOKEN,
  };

  test("a bearer server whose name resolves to a refused address is not stored or called", async () => {
    const context = setup({
      remote: { oauth: false, accepted: [FAKE_TOKEN] },
      addressProblem: "address_not_allowed",
    });
    expect(await refusal(context.service.create(admin, bearerBody))).toEqual({
      code: "BAD_REQUEST",
      reason: "address_not_allowed",
    });
    expect(context.addressAsked).toEqual([FAKE_MCP_URL]);
    expect(context.remote.requests).toEqual([]);
    expect((await context.service.list(admin)).items).toEqual([]);
  });

  test("a bearer server whose name does not resolve is 503, not stored", async () => {
    const context = setup({
      remote: { oauth: false, accepted: [FAKE_TOKEN] },
      addressProblem: "unreachable",
    });
    expect(await refusal(context.service.create(admin, bearerBody))).toEqual({
      code: "BACKEND_UNAVAILABLE",
      reason: "mcp_unreachable",
    });
    expect(context.remote.requests).toEqual([]);
    expect((await context.service.list(admin)).items).toEqual([]);
  });

  test("an OAuth server and discovery are judged by the pinned discovery, not a second lookup", async () => {
    const context = setup({ addressProblem: "address_not_allowed" });
    await context.service.discover(admin, FAKE_MCP_URL);
    await context.service.create(admin, oauthBody);
    expect(context.addressAsked).toEqual([]);
  });

  test("an empty fragment is refused as discovery refuses it", async () => {
    const context = setup();
    expect(
      await refusal(
        context.service.create(admin, {
          ...bearerBody,
          url: `${FAKE_MCP_URL}#`,
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "url_invalid" });
    expect(context.addressAsked).toEqual([]);
  });

  // The https-IP cause comes from the injected check; apps/control-host/src/api/workspace-mcp.test.ts runs it for real.
  test("a malformed URL, account information and a fragment all answer url_invalid", async () => {
    const causes = [
      "mcp.example.com/mcp",
      "https://user@mcp.example.com/mcp",
      "https://mcp.example.com/mcp#section",
    ];
    for (const url of causes) {
      const context = setup();
      expect(
        await refusal(context.service.create(admin, { ...bearerBody, url })),
      ).toEqual({ code: "BAD_REQUEST", reason: "url_invalid" });
      expect(context.addressAsked).toEqual([]);
    }
  });

  test("a URL refused before the lookup is never looked up", async () => {
    const context = setup({ urlProblem: "url_invalid" });
    expect(await refusal(context.service.create(admin, bearerBody))).toEqual({
      code: "BAD_REQUEST",
      reason: "url_invalid",
    });
    expect(context.addressAsked).toEqual([]);
  });

  test("a server of a kind a later release stored lists as stored and takes no credential change", async () => {
    const context = setup({ remote: { oauth: false, accepted: [FAKE_TOKEN] } });
    const created = await context.service.create(admin, {
      name: "wiki",
      url: FAKE_MCP_URL,
      auth_kind: "bearer",
      token: FAKE_TOKEN,
    });
    const stored = context.memory.stored(created.id);
    if (!stored) throw new Error("the server is not stored");
    stored.record.authKind = "mtls";
    stored.bearer = null;
    // A value in the OAuth slot is not sent for a kind this release does not know.
    stored.access = "x".repeat(12);

    const listed = workspaceMcpServerListSchema.parse(
      await context.service.list(member),
    );
    expect(listed.items).toMatchObject([
      {
        id: created.id,
        auth_kind: "mtls",
        redirect_uri: null,
        oauth: null,
        bearer: null,
      },
    ]);
    expect(
      await refusal(
        context.service.putBearerToken(admin, created.id, {
          token: FAKE_TOKEN,
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "not_bearer" });
    expect(
      await refusal(
        context.service.putOAuthClient(admin, created.id, { client_id: "c1" }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "not_oauth" });
    expect(
      await refusal(context.service.startOAuth(admin, created.id)),
    ).toEqual({ code: "BAD_REQUEST", reason: "not_oauth" });
    // Nothing to send its calls with: the grant is refused, not filled.
    expect(
      await context.service.credentialFor(WORKSPACE, created.id),
    ).toBeNull();
    // Left as it is: a later release connects it, not this one.
    const before = structuredClone(stored.record.connection);
    expect(
      await refusal(context.service.disconnect(admin, created.id)),
    ).toEqual({ code: "BAD_REQUEST", reason: "auth_kind_unsupported" });
    expect(context.memory.stored(created.id)?.record.connection).toEqual(
      before,
    );
    expect(
      await refusal(context.service.refreshTools(admin, created.id)),
    ).toEqual({ code: "BAD_REQUEST", reason: "not_connected" });
  });

  test("a server that takes no credential stores nothing, reads its tools with no Authorization and takes no credential change", async () => {
    const context = setup({ remote: { oauth: false, anonymous: true } });
    const created = await context.service.create(admin, {
      name: "deepwiki",
      url: FAKE_MCP_URL,
      auth_kind: "none",
    });
    expect(context.addressAsked).toEqual([FAKE_MCP_URL]);
    expect(created).toMatchObject({
      auth_kind: "none",
      redirect_uri: null,
      oauth: null,
      bearer: null,
      connection: { state: "active", connected_by: null },
    });
    expect(created.tools.length).toBeGreaterThan(0);
    const sent = context.remote.requests.filter((r) => r.url === FAKE_MCP_URL);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((r) => r.headers?.Authorization ?? null)).toEqual(
      sent.map(() => null),
    );
    expect(context.memory.stored(created.id)?.bearer).toBeNull();
    expect(await context.service.credentialFor(WORKSPACE, created.id)).toEqual({
      kind: "none",
    });
    const asks = [
      () =>
        context.service.putBearerToken(admin, created.id, {
          token: FAKE_TOKEN,
        }),
      () =>
        context.service.putOAuthClient(admin, created.id, { client_id: "c1" }),
      () => context.service.startOAuth(admin, created.id),
      () => context.service.disconnect(admin, created.id),
    ];
    for (const ask of asks) {
      expect(await refusal(ask())).toEqual({
        code: "BAD_REQUEST",
        reason: "no_credential",
      });
    }
    // Still nothing stored, still connected.
    expect(context.memory.stored(created.id)?.bearer).toBeNull();
    const refreshed = await context.service.refreshTools(admin, created.id);
    expect(refreshed.tools).toEqual(created.tools);
    expect(refreshed.connection.state).toBe("active");
    await context.service.delete(admin, created.id);
    expect(context.memory.stored(created.id)).toBeUndefined();
  });

  test("a credential left on a server that takes none, or of a kind this release does not know, is never sent", async () => {
    // A row a migration did not clean: the kind says none, the slots still hold values.
    const context = setup({ remote: { oauth: false, anonymous: true } });
    const leftover = async (name: string, kind: string) => {
      const created = await context.service.create(admin, {
        ...bearerBody,
        name,
      });
      const stored = context.memory.stored(created.id);
      if (!stored) throw new Error("the server is not stored");
      stored.record.authKind = kind as "none";
      stored.access = "y".repeat(12);
      expect(stored.bearer).not.toBeNull();
      return created.id;
    };
    const none = await leftover("deepwiki", "none");
    const unknown = await leftover("later", "mtls");
    expect(await context.service.credentialFor(WORKSPACE, none)).toEqual({
      kind: "none",
    });
    expect(await context.service.credentialFor(WORKSPACE, unknown)).toBeNull();
    const before = context.remote.requests.length;
    const refreshed = await context.service.refreshTools(admin, none);
    expect(refreshed.tools.length).toBeGreaterThan(0);
    const sent = context.remote.requests.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((r) => r.headers?.Authorization ?? null)).toEqual(
      sent.map(() => null),
    );
  });

  test("a bearer server still stores its token and sends it", async () => {
    const context = setup({ remote: { oauth: false, accepted: [FAKE_TOKEN] } });
    const created = await context.service.create(admin, bearerBody);
    expect(created.connection).toMatchObject({
      state: "active",
      connected_by: { user_id: ADMIN },
    });
    expect(await context.service.credentialFor(WORKSPACE, created.id)).toEqual({
      kind: "bearer",
      token: FAKE_TOKEN,
    });
    const sent = context.remote.requests.filter((r) => r.url === FAKE_MCP_URL);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((r) => r.headers?.Authorization)).toEqual(
      sent.map(() => `Bearer ${FAKE_TOKEN}`),
    );
    expect(
      await refusal(
        context.service.putOAuthClient(admin, created.id, { client_id: "c1" }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "not_oauth" });
  });

  test("a bearer server that passes is stored and its tools read", async () => {
    const context = setup({ remote: { oauth: false, accepted: [FAKE_TOKEN] } });
    const created = await context.service.create(admin, bearerBody);
    expect(created.name).toBe("tracker");
    expect(context.addressAsked).toEqual([FAKE_MCP_URL]);
  });
});
