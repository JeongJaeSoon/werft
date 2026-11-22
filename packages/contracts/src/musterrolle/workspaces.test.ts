import { describe, expect, test } from "bun:test";

import {
  acceptInviteRequestSchema,
  authMeResponseSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_VALUE,
  loginRequestSchema,
  loginResponseSchema,
  PASSWORD_MIN_LENGTH,
  WEB_SESSION_COOKIE_NAME,
} from "./auth.ts";
import {
  achievementJudgeSettingsSchema,
  auditRetentionRequestSchema,
  clampDisplayName,
  createInviteRequestSchema,
  createInviteResponseSchema,
  DISPLAY_NAME_MAX,
  displayNameSchema,
  inviteSchema,
  memberViewSchema,
  normalizeEmail,
  updateMemberRequestSchema,
  workspaceSchema,
  workspaceSettingsSchema,
} from "./workspaces.ts";

const USER_ID = "019a0000-0000-7000-8000-0000000000d1";
const WORKSPACE_ID = "019a0000-0000-7000-8000-0000000000d2";
const INVITE_ID = "019a0000-0000-7000-8000-0000000000d3";
const AT = "2026-09-22T01:00:00Z";
const PASSWORD = "correct horse battery";

describe("display names", () => {
  test("a derived name is trimmed and cut to the limit without splitting a surrogate pair", () => {
    expect(clampDisplayName("  Alice  ")).toBe("Alice");
    expect(clampDisplayName(" \t ")).toBe("");
    expect(clampDisplayName("a".repeat(DISPLAY_NAME_MAX + 5))).toBe(
      "a".repeat(DISPLAY_NAME_MAX),
    );
    // The emoji's high surrogate would be the 64th code unit.
    const split = clampDisplayName(`${"a".repeat(DISPLAY_NAME_MAX - 1)}😀b`);
    expect(split).toBe("a".repeat(DISPLAY_NAME_MAX - 1));
    expect(displayNameSchema.safeParse(split).success).toBe(true);
    expect(clampDisplayName(`${"a".repeat(DISPLAY_NAME_MAX - 2)}😀`)).toBe(
      `${"a".repeat(DISPLAY_NAME_MAX - 2)}😀`,
    );
    // A cut that lands before a space leaves no trailing blank.
    expect(clampDisplayName(`${"a".repeat(DISPLAY_NAME_MAX - 1)} b`)).toBe(
      "a".repeat(DISPLAY_NAME_MAX - 1),
    );
  });

  test("a stored name with padding still reads", () => {
    expect(displayNameSchema.safeParse(" Alice ").success).toBe(true);
  });
});

describe("workspace", () => {
  test("fills settings with the documented defaults", () => {
    const workspace = workspaceSchema.parse({
      id: WORKSPACE_ID,
      slug: "acme",
      name: "Acme",
      settings: {},
      created_at: AT,
    });
    expect(workspace.settings).toEqual({
      dispatch_model: null,
      kill_switch: false,
      daily_cost_limit_usd: null,
      idle_pause_minutes: 30,
      audit_retention_days: 90,
      slack_guest_enabled: false,
      achievement_judge: {
        connection_id: null,
        threshold: 0.9,
        on_evidence: true,
        every_n_turns: null,
        on_idle: false,
        transcript: "recent",
        daily_budget_usd: 1,
        max_per_session: 20,
      },
    });
    expect(
      workspaceSchema.safeParse({ ...workspace, slug: "Acme" }).success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({ idle_pause_minutes: 0 }).success,
    ).toBe(false);
  });

  test("the achievement judge takes the design's fields and no backend or model", () => {
    const judge = (value: Record<string, unknown>) =>
      achievementJudgeSettingsSchema.safeParse(value).success;
    expect(judge({})).toBe(true);
    expect(judge({ every_n_turns: 5 })).toBe(true);
    expect(judge({ every_n_turns: 100 })).toBe(true);
    expect(judge({ every_n_turns: 4 })).toBe(false);
    expect(judge({ every_n_turns: 101 })).toBe(false);
    expect(judge({ every_n_turns: 7.5 })).toBe(false);
    expect(judge({ threshold: 1 })).toBe(true);
    expect(judge({ threshold: 1.1 })).toBe(false);
    expect(judge({ transcript: "none" })).toBe(true);
    expect(judge({ transcript: "full" })).toBe(false);
    expect(judge({ daily_budget_usd: -1 })).toBe(false);
    expect(judge({ max_per_session: 0 })).toBe(false);
    expect(judge({ backend: "luna" })).toBe(false);
    expect(judge({ model: "gpt-5" })).toBe(false);
    expect(
      workspaceSettingsSchema.parse({ achievement_judge: { on_idle: true } })
        .achievement_judge,
    ).toEqual({
      connection_id: null,
      threshold: 0.9,
      on_evidence: true,
      every_n_turns: null,
      on_idle: true,
      transcript: "recent",
      daily_budget_usd: 1,
      max_per_session: 20,
    });
  });

  test("keeps audit rows at least 30 days, whole days only", () => {
    const days = (value: unknown) =>
      auditRetentionRequestSchema.safeParse({ audit_retention_days: value })
        .success;
    expect(days(30)).toBe(true);
    expect(days(3650)).toBe(true);
    expect(days(29)).toBe(false);
    expect(days(30.5)).toBe(false);
    expect(days(3651)).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({ audit_retention_days: 29 }).success,
    ).toBe(false);
  });

  test("separates a suspended account from a disabled membership", () => {
    const member = memberViewSchema.parse({
      user_id: USER_ID,
      email: "someone@example.com",
      display_name: "Someone",
      role: "member",
      disabled_at: AT,
      created_at: AT,
    });
    expect(member.disabled_at).toBe(AT);
  });

  test("normalizes the email before it is compared", () => {
    expect(normalizeEmail("  Someone@Example.COM ")).toBe(
      "someone@example.com",
    );
  });

  test("a member patch says what it changes", () => {
    expect(updateMemberRequestSchema.safeParse({}).success).toBe(false);
    expect(updateMemberRequestSchema.safeParse({ role: "owner" }).success).toBe(
      true,
    );
    expect(updateMemberRequestSchema.safeParse({ role: "admin" }).success).toBe(
      true,
    );
    expect(updateMemberRequestSchema.safeParse({ role: "guest" }).success).toBe(
      false,
    );
  });
});

describe("invites hold no redeemable token", () => {
  const invite = {
    id: INVITE_ID,
    workspace_id: WORKSPACE_ID,
    email: "invitee@example.com",
    role: "member",
    invited_by: USER_ID,
    status: "pending",
    expires_at: AT,
    accepted_at: null,
    revoked_at: null,
    created_at: AT,
  };

  test("the stored row rejects both the token and its hash", () => {
    expect(inviteSchema.safeParse(invite).success).toBe(true);
    expect(
      inviteSchema.safeParse({ ...invite, token: "t".repeat(40) }).success,
    ).toBe(false);
    expect(
      inviteSchema.safeParse({ ...invite, token_hash: "a".repeat(64) }).success,
    ).toBe(false);
  });

  test("the status and the audit timestamps give the same answer", () => {
    // Both answer "is this still redeemable"; a consumer reading one and a
    // consumer reading the other must not disagree.
    expect(
      inviteSchema.safeParse({ ...invite, status: "accepted" }).success,
    ).toBe(false);
    expect(
      inviteSchema.safeParse({
        ...invite,
        status: "accepted",
        accepted_at: AT,
      }).success,
    ).toBe(true);
    expect(inviteSchema.safeParse({ ...invite, accepted_at: AT }).success).toBe(
      false,
    );
    expect(
      inviteSchema.safeParse({ ...invite, status: "revoked", revoked_at: AT })
        .success,
    ).toBe(true);
    expect(
      inviteSchema.safeParse({ ...invite, status: "revoked" }).success,
    ).toBe(false);
    // `expired` has no timestamp of its own — `expires_at` already carries it
    // and the clock, not a write, makes a row expired.
    expect(
      inviteSchema.safeParse({ ...invite, status: "expired" }).success,
    ).toBe(true);
  });

  test("the token exists only in the create response, once", () => {
    expect(
      createInviteRequestSchema.safeParse({
        email: "invitee@example.com",
        role: "member",
      }).success,
    ).toBe(true);
    const created = createInviteResponseSchema.parse({
      invite_id: INVITE_ID,
      invite_token: "t".repeat(40),
      expires_at: AT,
    });
    expect(created.invite_token).toHaveLength(40);
    expect(
      createInviteResponseSchema.safeParse({
        invite_id: INVITE_ID,
        invite_token: "short",
        expires_at: AT,
      }).success,
    ).toBe(false);
  });
});

describe("auth requests", () => {
  test("bootstrap needs the setup link's token and everything a first owner implies", () => {
    const body = {
      setup_token: "b".repeat(32),
      email: "owner@example.com",
      password: PASSWORD,
      display_name: "Owner",
      workspace_name: "Acme",
      workspace_slug: "acme",
    };
    expect(bootstrapRequestSchema.safeParse(body).success).toBe(true);
    const { setup_token: _omitted, ...withoutToken } = body;
    expect(bootstrapRequestSchema.safeParse(withoutToken).success).toBe(false);
    expect(
      bootstrapRequestSchema.safeParse({ ...body, password: "short" }).success,
    ).toBe(false);
    expect(PASSWORD.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
  });

  test("login is closed and an invite never forces a new password", () => {
    expect(
      loginRequestSchema.safeParse({
        email: "owner@example.com",
        password: PASSWORD,
        remember: true,
      }).success,
    ).toBe(false);
    const token = `apv_${"a".repeat(43)}`;
    expect(acceptInviteRequestSchema.safeParse({ token }).success).toBe(false);
    expect(
      acceptInviteRequestSchema.safeParse({ password: PASSWORD }).success,
    ).toBe(false);
    expect(
      acceptInviteRequestSchema.safeParse({
        token,
        password: PASSWORD,
        display_name: "Invitee",
      }).success,
    ).toBe(true);
  });

  test("no response schema can carry a password back", () => {
    const me = {
      principal: {
        kind: "user",
        id: USER_ID,
        workspace_id: WORKSPACE_ID,
        role: "owner",
        scopes: ["sessions:read"],
      },
      user: {
        id: USER_ID,
        email: "owner@example.com",
        display_name: "Owner",
        locale: "en",
      },
      workspace: {
        id: WORKSPACE_ID,
        slug: "acme",
        name: "Acme",
        settings: {},
        created_at: AT,
      },
      scopes: ["sessions:read"],
      permissions: ["member.manage"],
    };
    expect(authMeResponseSchema.safeParse(me).success).toBe(true);
    expect(
      authMeResponseSchema.safeParse({ ...me, password: PASSWORD }).success,
    ).toBe(false);
  });

  test("a response cannot describe more authority than its own ceiling", () => {
    // A client builds its idea of what it may do from these bodies, so the
    // role ceiling has to hold here and not only on the stored principal.
    const login = {
      user_id: USER_ID,
      workspace_id: WORKSPACE_ID,
      role: "member",
      scopes: ["sessions:approve"],
      expires_at: AT,
    };
    expect(loginResponseSchema.safeParse(login).success).toBe(true);
    expect(
      loginResponseSchema.safeParse({
        ...login,
        scopes: ["sessions:recover"],
      }).success,
    ).toBe(false);
    expect(
      loginResponseSchema.safeParse({
        ...login,
        role: "owner",
        scopes: ["sessions:recover"],
      }).success,
    ).toBe(true);

    const me = {
      principal: {
        kind: "user",
        id: USER_ID,
        workspace_id: WORKSPACE_ID,
        role: "owner",
        scopes: ["sessions:read"],
      },
      user: {
        id: USER_ID,
        email: "owner@example.com",
        display_name: "Owner",
        locale: null,
      },
      workspace: {
        id: WORKSPACE_ID,
        slug: "acme",
        name: "Acme",
        settings: {},
        created_at: AT,
      },
      scopes: ["sessions:read", "sessions:control"],
      permissions: [],
    };
    expect(authMeResponseSchema.safeParse(me).success).toBe(false);
    expect(authMeResponseSchema.safeParse({ ...me, scopes: [] }).success).toBe(
      true,
    );
  });

  test("the /me projection describes the principal that authenticated", () => {
    // It is assembled from joins; a mismatched one hands the web client
    // someone else's identity or tenant and nothing downstream would notice.
    const workspace = {
      id: WORKSPACE_ID,
      slug: "acme",
      name: "Acme",
      settings: {},
      created_at: AT,
    };
    const me = {
      principal: {
        kind: "user",
        id: USER_ID,
        workspace_id: WORKSPACE_ID,
        role: "owner",
        scopes: ["sessions:read"],
      },
      user: {
        id: USER_ID,
        email: "owner@example.com",
        display_name: "Owner",
        locale: null,
      },
      workspace,
      scopes: ["sessions:read"],
      permissions: ["team.manage"],
    };
    expect(authMeResponseSchema.safeParse(me).success).toBe(true);
    expect(
      authMeResponseSchema.safeParse({
        ...me,
        user: { ...me.user, id: INVITE_ID },
      }).success,
    ).toBe(false);
    expect(authMeResponseSchema.safeParse({ ...me, user: null }).success).toBe(
      false,
    );
    expect(
      authMeResponseSchema.safeParse({
        ...me,
        workspace: { ...workspace, id: INVITE_ID },
      }).success,
    ).toBe(false);

    // An api key has no human behind it, and a legacy key has no workspace.
    const keyMe = {
      principal: {
        kind: "api_key",
        id: "key_1",
        owner_id: "owner_1",
        workspace_id: null,
        scopes: [],
      },
      user: null,
      workspace: null,
      scopes: [],
      permissions: [],
    };
    expect(authMeResponseSchema.safeParse(keyMe).success).toBe(true);
    expect(
      authMeResponseSchema.safeParse({ ...keyMe, permissions: ["team.manage"] })
        .success,
    ).toBe(false);
    expect(
      authMeResponseSchema.safeParse({ ...me, permissions: ["not.an.action"] })
        .success,
    ).toBe(false);
    expect(
      authMeResponseSchema.safeParse({ ...keyMe, workspace }).success,
    ).toBe(false);
    expect(
      authMeResponseSchema.safeParse({ ...keyMe, user: me.user }).success,
    ).toBe(false);
  });

  test("bootstrap leaves an owner behind, never a member", () => {
    const body = {
      user_id: USER_ID,
      workspace: {
        id: WORKSPACE_ID,
        slug: "acme",
        name: "Acme",
        settings: {},
        created_at: AT,
      },
      role: "owner",
    };
    expect(bootstrapResponseSchema.safeParse(body).success).toBe(true);
    expect(
      bootstrapResponseSchema.safeParse({ ...body, role: "member" }).success,
    ).toBe(false);
  });

  test("names the cookie and the CSRF header the web surface must send", () => {
    expect(WEB_SESSION_COOKIE_NAME).toBe("__Host-werft_session");
    expect(CSRF_HEADER_VALUE).toBe("werft-web");
  });
});
