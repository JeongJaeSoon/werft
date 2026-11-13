import { describe, expect, test } from "bun:test";
import {
  acceptInviteResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createInviteResponseSchema,
  DISPLAY_NAME_MAX,
  listInvitesResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type AcceptInviteInput,
  type AuthorizationPolicy,
  type Caller,
  createAuthorizationPolicy,
  createInviteService,
  type IdentityWorkspace,
  type InviteRecord,
  type InviteService,
  type InviteStore,
  type LoginSettingsStore,
} from "@werft-ai/platform";
import { errorOf } from "../../../testing/api-error.ts";
import { hashPassword, hashWebSessionToken, LoginLockout } from "../../auth.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerInviteRoutes, registerPublicInviteRoutes } from "./invites.ts";

const createApiApp = recordRouteErrors("routes/musterrolle/invites.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER_USER = "019a0000-0000-7000-8000-0000000000a1";
const EXISTING_USER = "019a0000-0000-7000-8000-0000000000b1";
const INVITE = "019a0000-0000-7000-8000-0000000000e1";
const PASSWORD = "correct horse battery";
const TOKEN = `apv_${"a".repeat(43)}`;
const STORED_HASH = await hashPassword(PASSWORD);

const allowing: AuthorizationPolicy = {
  authorize: async () => ({
    outcome: "allow",
    reason_code: "ok",
    effective_scopes: [],
    policy_version: "test",
    decision_id: crypto.randomUUID(),
  }),
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );

const PENDING: InviteRecord = {
  id: INVITE,
  workspaceId: WORKSPACE,
  email: "invitee@example.com",
  role: "member",
  invitedBy: OWNER_USER,
  status: "pending",
  expiresAt: new Date("2026-10-18T00:00:00.000Z"),
  acceptedAt: null,
  revokedAt: null,
  createdAt: new Date("2026-10-11T00:00:00.000Z"),
};

const WORKSPACE_ROW: IdentityWorkspace = {
  id: WORKSPACE,
  slug: "acme",
  name: "Acme",
  settings: {},
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
};

function inviteStore(overrides: Partial<InviteStore> = {}): InviteStore {
  return {
    createInvite: async (input) => ({
      outcome: "created",
      invite: { ...PENDING, id: input.id, email: input.email },
    }),
    listInvites: async () => [
      PENDING,
      {
        ...PENDING,
        id: crypto.randomUUID(),
        status: "revoked",
        revokedAt: new Date("2026-10-11T01:00:00.000Z"),
      },
    ],
    revokeInvite: async () => ({ outcome: "revoked" }),
    peekInvite: async () => ({
      outcome: "pending",
      email: PENDING.email,
      existingUser: null,
    }),
    acceptInvite: async (input) => ({
      outcome: "accepted",
      userId: input.account.userId,
      workspaceId: WORKSPACE,
      role: "member",
      sessionExpiresAt: new Date("2026-10-25T00:00:00.000Z"),
    }),
    listMembers: async () => ({ items: [], next_cursor: null }),
    changeMemberRole: async () => ({ outcome: "not_found" }),
    ...overrides,
  };
}

function asPerson(caller: Caller): Caller {
  return {
    ...caller,
    actor: {
      principal: { kind: "user", id: OWNER_USER },
      userId: OWNER_USER,
      workspaceId: WORKSPACE,
      apiKeyId: null,
    },
  };
}

function app(
  store: InviteStore = inviteStore(),
  options: {
    authorization?: AuthorizationPolicy;
    person?: boolean;
    lockout?: LoginLockout;
    loginSettings?: Pick<LoginSettingsStore, "read">;
  } = {},
) {
  const service = createInviteService({
    authorization: options.authorization ?? allowing,
    store,
  });
  const routed: Pick<
    InviteService,
    "issueInvite" | "listInvites" | "revokeInvite"
  > =
    options.person === false
      ? service
      : {
          issueInvite: (caller, input) =>
            service.issueInvite(asPerson(caller), input),
          listInvites: (caller) => service.listInvites(asPerson(caller)),
          revokeInvite: (caller, id) =>
            service.revokeInvite(asPerson(caller), id),
        };
  return createApiApp({
    authMode: "none",
    registerPublicRoutes: (router) =>
      registerPublicInviteRoutes(router, {
        invites: store,
        identity: { findWorkspace: async () => WORKSPACE_ROW },
        ...(options.lockout ? { lockout: options.lockout } : {}),
        ...(options.loginSettings
          ? { loginSettings: options.loginSettings }
          : {}),
      }),
    registerRoutes: (router) => registerInviteRoutes(router, routed),
  });
}

const owner = { "X-Owner-Id": WORKSPACE };

function send(
  api: ReturnType<typeof app>,
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = owner,
) {
  return api.request(path, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /v1/invites", () => {
  test("returns the token once and hands the store only its hash", async () => {
    let stored: Uint8Array | undefined;
    const response = await send(
      app(
        inviteStore({
          createInvite: async (input) => {
            stored = input.tokenHash;
            expect(input.ttlMs).toBe(7 * 24 * 60 * 60 * 1000);
            expect(input.actor.userId).toBe(OWNER_USER);
            expect(input.email).toBe("invitee@example.com");
            return {
              outcome: "created",
              invite: { ...PENDING, id: input.id, email: input.email },
            };
          },
        }),
      ),
      "/v1/invites",
      "POST",
      { email: "Invitee@Example.com", role: "member" },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = createInviteResponseSchema.parse(await response.json());
    expect(body.invite_token).toMatch(/^apv_[A-Za-z0-9_-]{43}$/);
    expect(stored).toEqual(hashWebSessionToken(body.invite_token));
    expect(body.expires_at).toBe(PENDING.expiresAt.toISOString());
  });

  test("an address that is already a member, or a bad body, is refused", async () => {
    const member = await send(
      app(
        inviteStore({
          createInvite: async () => ({ outcome: "already_member" }),
        }),
      ),
      "/v1/invites",
      "POST",
      { email: "invitee@example.com", role: "member" },
    );
    expect(member.status).toBe(400);
    const bad = await send(app(), "/v1/invites", "POST", {
      email: "invitee@example.com",
      role: "guest",
    });
    expect(bad.status).toBe(400);
    const huge = await send(
      app(),
      "/v1/invites",
      "POST",
      JSON.stringify({ email: "a@b.c", role: "member", pad: "x".repeat(2e6) }),
    );
    expect(huge.status).toBe(413);
  });

  test("refuses an API key whatever its scopes", async () => {
    const response = await send(
      app(inviteStore(), {
        authorization: createAuthorizationPolicy(),
        person: false,
      }),
      "/v1/invites",
      "POST",
      { email: "invitee@example.com", role: "member" },
    );
    expect(response.status).toBe(403);
  });

  test("maps a storage outage to 503", async () => {
    const response = await send(
      app(inviteStore({ createInvite: outage })),
      "/v1/invites",
      "POST",
      { email: "invitee@example.com", role: "member" },
    );
    expect(response.status).toBe(503);
  });
});

describe("GET /v1/invites", () => {
  test("lists invites with their status and no token", async () => {
    const response = await app().request("/v1/invites", { headers: owner });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = listInvitesResponseSchema.parse(JSON.parse(raw));
    expect(body.items.map((invite) => invite.status)).toEqual([
      "pending",
      "revoked",
    ]);
    expect(raw).not.toContain("token");
  });

  test("refuses an API key whatever its scopes", async () => {
    const response = await app(inviteStore(), {
      authorization: createAuthorizationPolicy(),
      person: false,
    }).request("/v1/invites", { headers: owner });
    expect(response.status).toBe(403);
  });

  test("maps a storage outage to 503", async () => {
    const response = await app(inviteStore({ listInvites: outage })).request(
      "/v1/invites",
      { headers: owner },
    );
    expect(response.status).toBe(503);
  });
});

describe("DELETE /v1/invites/{id}", () => {
  const revoke = (api: ReturnType<typeof app>, id = INVITE) =>
    api.request(`/v1/invites/${id}`, { method: "DELETE", headers: owner });

  test("revokes, and revoking twice is a no-op", async () => {
    expect((await revoke(app())).status).toBe(204);
    const again = await revoke(
      app(
        inviteStore({
          revokeInvite: async () => ({ outcome: "already_revoked" }),
        }),
      ),
    );
    expect(again.status).toBe(204);
  });

  test("an accepted invite cannot be revoked", async () => {
    const response = await revoke(
      app(inviteStore({ revokeInvite: async () => ({ outcome: "accepted" }) })),
    );
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("INVITE_USED");
  });

  test("a missing invite and a malformed id are both not found", async () => {
    const missing = await revoke(
      app(
        inviteStore({ revokeInvite: async () => ({ outcome: "not_found" }) }),
      ),
    );
    expect(missing.status).toBe(404);
    expect((await revoke(app(), "nope")).status).toBe(404);
  });

  test("refuses an API key whatever its scopes", async () => {
    const response = await revoke(
      app(inviteStore(), {
        authorization: createAuthorizationPolicy(),
        person: false,
      }),
    );
    expect(response.status).toBe(403);
  });

  test("maps a storage outage to 503", async () => {
    expect(
      (await revoke(app(inviteStore({ revokeInvite: outage })))).status,
    ).toBe(503);
  });
});

describe("POST /v1/invites/accept", () => {
  const browser = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
  const accept = (
    api: ReturnType<typeof app>,
    body: unknown = { token: TOKEN, password: PASSWORD },
    headers: Record<string, string> = browser,
  ) => send(api, "/v1/invites/accept", "POST", body, headers);

  function existing(overrides: Partial<InviteStore> = {}) {
    return inviteStore({
      peekInvite: async () => ({
        outcome: "pending",
        email: PENDING.email,
        existingUser: { id: EXISTING_USER, passwordHash: STORED_HASH },
      }),
      ...overrides,
    });
  }

  test("an unknown address gets an account and a session cookie", async () => {
    let asked: AcceptInviteInput | undefined;
    const response = await accept(
      app(
        inviteStore({
          acceptInvite: async (input) => {
            asked = input;
            return {
              outcome: "accepted",
              userId: input.account.userId,
              workspaceId: WORKSPACE,
              role: "member",
              sessionExpiresAt: new Date("2026-10-25T00:00:00.000Z"),
            };
          },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain(
      `${WEB_SESSION_COOKIE_NAME}=`,
    );
    const body = acceptInviteResponseSchema.parse(await response.json());
    expect(body.workspace.id).toBe(WORKSPACE);
    expect(asked?.tokenHash).toEqual(hashWebSessionToken(TOKEN));
    expect(asked?.account).toMatchObject({
      kind: "new",
      displayName: "invitee",
    });
  });

  test("a default name from a long local part fits a display name", async () => {
    let asked: AcceptInviteInput | undefined;
    const email = `${"a".repeat(DISPLAY_NAME_MAX + 1)}@example.com`;
    const response = await accept(
      app(
        inviteStore({
          peekInvite: async () => ({
            outcome: "pending",
            email,
            existingUser: null,
          }),
          acceptInvite: async (input) => {
            asked = input;
            return {
              outcome: "accepted",
              userId: input.account.userId,
              workspaceId: WORKSPACE,
              role: "member",
              sessionExpiresAt: new Date("2026-10-25T00:00:00.000Z"),
            };
          },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(asked?.account).toMatchObject({
      kind: "new",
      displayName: "a".repeat(DISPLAY_NAME_MAX),
    });
  });

  test("an existing account joins with its own password, unchanged", async () => {
    let asked: AcceptInviteInput | undefined;
    const response = await accept(
      app(
        existing({
          acceptInvite: async (input) => {
            asked = input;
            return {
              outcome: "accepted",
              userId: EXISTING_USER,
              workspaceId: WORKSPACE,
              role: "member",
              sessionExpiresAt: new Date("2026-10-25T00:00:00.000Z"),
            };
          },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(asked?.account).toEqual({
      kind: "existing",
      userId: EXISTING_USER,
      verifiedPasswordHash: STORED_HASH,
    });
  });

  test("a wrong password for an existing account is refused, then locked out", async () => {
    const api = app(existing(), { lockout: new LoginLockout({ attempts: 1 }) });
    const wrong = { token: TOKEN, password: "not the password" };
    const first = await accept(api, wrong);
    expect(first.status).toBe(401);
    expect((await errorOf(first)).message).toBe(
      "Invite token or password is invalid",
    );
    expect((await accept(api, wrong)).status).toBe(429);
  });

  test("an account changed between check and write is refused", async () => {
    const response = await accept(
      app(
        existing({
          acceptInvite: async () => ({ outcome: "account_changed" }),
        }),
      ),
    );
    expect(response.status).toBe(401);
  });

  test("revoked, replaced, expired and unknown tokens are gone; a used one conflicts", async () => {
    for (const outcome of ["expired", "unknown"] as const) {
      const response = await accept(
        app(inviteStore({ peekInvite: async () => ({ outcome }) })),
      );
      expect(response.status).toBe(410);
      expect((await errorOf(response)).code).toBe("INVITE_EXPIRED");
    }
    const used = await accept(
      app(inviteStore({ peekInvite: async () => ({ outcome: "used" }) })),
    );
    expect(used.status).toBe(409);
    expect((await errorOf(used)).code).toBe("INVITE_USED");
    // A second tab that lost the race at the write.
    const raced = await accept(
      app(inviteStore({ acceptInvite: async () => ({ outcome: "used" }) })),
    );
    expect(raced.status).toBe(409);
  });

  test("while passwords are closed the invite is refused with why, and no session is made", async () => {
    const response = await accept(
      app(
        inviteStore({
          acceptInvite: async () => ({ outcome: "password_closed" }),
        }),
      ),
    );
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "password_login_closed" },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("while passwords are closed the invite is refused before the password is looked at: right or wrong, the same answer and no count", async () => {
    const closed: Pick<LoginSettingsStore, "read"> = {
      read: async () => ({
        passwordLogin: "emergency_only",
        emergencyAdmin: {
          userId: OWNER_USER,
          email: "owner@example.com",
          displayName: "Owner",
          eligible: true,
        },
        enabledProviders: 1,
      }),
    };
    // An address with an account, and one without.
    for (const store of [existing, inviteStore]) {
      const lockout = new LoginLockout({ attempts: 1 });
      let asked = 0;
      const api = app(
        store({
          acceptInvite: async () => {
            asked += 1;
            return { outcome: "password_closed" };
          },
        }),
        { lockout, loginSettings: closed },
      );
      const answers: unknown[] = [];
      for (const password of [PASSWORD, "not the password", PASSWORD]) {
        const response = await accept(api, { token: TOKEN, password });
        const { code, message, details } = await errorOf(response);
        answers.push({
          status: response.status,
          code,
          message,
          details,
          cookies: response.headers.getSetCookie(),
        });
      }
      expect(answers[0]).toMatchObject({
        status: 403,
        code: "FORBIDDEN",
        details: { reason_code: "password_login_closed" },
        cookies: [],
      });
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[2]).toEqual(answers[0]);
      expect(asked).toBe(0);
      expect(lockout.size).toBe(0);
    }
  });

  test("the emergency admin's password is looked at while passwords are closed", async () => {
    const api = app(existing(), {
      loginSettings: {
        read: async () => ({
          passwordLogin: "emergency_only",
          emergencyAdmin: {
            userId: EXISTING_USER,
            email: PENDING.email,
            displayName: "Existing",
            eligible: true,
          },
          enabledProviders: 1,
        }),
      },
    });
    const wrong = await accept(api, {
      token: TOKEN,
      password: "not the password",
    });
    expect(wrong.status).toBe(401);
    expect((await accept(api)).status).toBe(200);
  });

  test("a right password clears the failures before it only by being accepted", async () => {
    const wrong = { token: TOKEN, password: "not the password" };
    const refusedThenWrong = async (
      outcome: "password_closed" | "account_changed" | "accepted",
    ) => {
      const api = app(
        existing(
          outcome === "accepted"
            ? {}
            : { acceptInvite: async () => ({ outcome }) },
        ),
        { lockout: new LoginLockout({ attempts: 3 }) },
      );
      expect((await accept(api, wrong)).status).toBe(401);
      const right = await accept(api);
      // Two are counted now, unless the right one was accepted.
      return [
        right.status,
        (await accept(api, wrong)).status,
        (await accept(api, wrong)).status,
      ];
    };
    expect(await refusedThenWrong("password_closed")).toEqual([403, 401, 429]);
    expect(await refusedThenWrong("account_changed")).toEqual([401, 401, 429]);
    expect(await refusedThenWrong("accepted")).toEqual([200, 401, 401]);
  });

  test("a refusal no password decides, and an outage, are not counted as guesses", async () => {
    for (const acceptInvite of [
      async () => ({ outcome: "emergency_admin" }) as const,
      async () => ({ outcome: "expired" }) as const,
      outage,
    ]) {
      const lockout = new LoginLockout({ attempts: 1 });
      const api = app(existing({ acceptInvite }), { lockout });
      const first = await accept(api);
      expect(first.status).not.toBe(429);
      expect(lockout.size).toBe(0);
      expect((await accept(api)).status).toBe(first.status);
    }
  });

  test("an invite that would move the emergency admin's sign-in is refused with why, and no session is made", async () => {
    const response = await accept(
      app(
        inviteStore({
          acceptInvite: async () => ({ outcome: "emergency_admin" }),
        }),
      ),
    );
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { reason_code: "emergency_admin" },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("needs the browser header, a password and a well-formed body", async () => {
    expect((await accept(app(), undefined, {})).status).toBe(403);
    expect((await accept(app(), { token: TOKEN })).status).toBe(400);
    expect((await accept(app(), { password: PASSWORD })).status).toBe(400);
    const huge = JSON.stringify({ token: TOKEN, pad: "x".repeat(2e6) });
    expect((await accept(app(), huge)).status).toBe(413);
  });

  test("maps a storage outage to 503", async () => {
    expect(
      (await accept(app(inviteStore({ peekInvite: outage })))).status,
    ).toBe(503);
  });
});
