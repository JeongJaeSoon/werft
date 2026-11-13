import { describe, expect, test } from "bun:test";
import {
  type LoginSettingsView,
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  type LoginSettingsRecord,
  type LoginSettingsStore,
  SessionServiceError,
} from "@werft-ai/platform";
import { createLoginSettingsAdmin } from "./login-settings.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
} as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function caller(who: keyof typeof USERS): Caller {
  const role: WorkspaceRole = who;
  const principal: Principal = {
    kind: "user",
    id: USERS[who],
    workspace_id: WORKSPACE,
    role,
    scopes: [...scopesForRole(role)],
  };
  return callerFor(principal, { kind: "web" }, crypto.randomUUID());
}

const apiKey = callerFor(
  {
    kind: "api_key",
    id: "key-1",
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopesForRole("owner")],
  } as Principal,
  { kind: "api" },
  crypto.randomUUID(),
);

const RECORD: LoginSettingsRecord = {
  passwordLogin: "on",
  emergencyAdmin: {
    userId: USERS.owner,
    email: "owner@example.com",
    displayName: "Owner",
    eligible: true,
  },
  enabledProviders: 1,
};
const VIEW: LoginSettingsView = {
  password_login: "on",
  emergency_admin: {
    user_id: USERS.owner,
    email: "owner@example.com",
    display_name: "Owner",
    eligible: true,
  },
  enabled_providers: 1,
};

type StoreMethod = keyof LoginSettingsStore;

/** The service over a store that answers what a test tells it to. */
function service(answers: Partial<Record<StoreMethod, unknown>> = {}) {
  const asked: Array<{ method: StoreMethod; input: unknown }> = [];
  const answering =
    (method: StoreMethod, fallback: unknown) => async (input?: unknown) => {
      asked.push({ method, input });
      return answers[method] ?? fallback;
    };
  const store = {
    read: answering("read", RECORD),
    setPasswordLogin: answering("setPasswordLogin", {
      outcome: "unchanged",
      settings: RECORD,
    }),
    setEmergencyAdmin: answering("setEmergencyAdmin", {
      outcome: "unchanged",
      settings: RECORD,
    }),
  } as unknown as LoginSettingsStore;
  const admin = createLoginSettingsAdmin({
    authorization: createAuthorizationPolicy({
      agents: { agentOf: async () => null, isAdmin: async () => false },
      decisions: { record: async () => {} },
    }),
    store,
  });
  return { admin, asked };
}

async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("sign-in settings service", () => {
  test("both methods are the signed-in owner's: an admin, a member and an owner's API key see and change nothing", async () => {
    const { admin, asked } = service();
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      for (const attempt of [
        admin.read(who),
        admin.change(who, { password_login: "emergency_only" }),
        admin.change(who, { emergency_admin_user_id: USERS.owner }),
      ]) {
        expect((await refusal(attempt)).code).toBe("FORBIDDEN");
      }
    }
    expect(asked).toEqual([]);
  });

  test("the owner reads the settings, and one with no emergency admin", async () => {
    expect(await service().admin.read(caller("owner"))).toEqual(VIEW);
    expect(
      await service({
        read: { ...RECORD, emergencyAdmin: null, enabledProviders: 0 },
      }).admin.read(caller("owner")),
    ).toEqual({ ...VIEW, emergency_admin: null, enabled_providers: 0 });
  });

  test("a change goes to the store as the owner's, with a receipt id of its own", async () => {
    const closed = { ...RECORD, passwordLogin: "emergency_only" as const };
    const { admin, asked } = service({
      setPasswordLogin: {
        outcome: "changed",
        settings: closed,
        sessionsRevoked: 4,
      },
      setEmergencyAdmin: {
        outcome: "changed",
        settings: RECORD,
        sessionsRevoked: 1,
      },
    });
    expect(
      await admin.change(caller("owner"), { password_login: "emergency_only" }),
    ).toEqual({
      settings: { ...VIEW, password_login: "emergency_only" },
      sessions_revoked: 4,
    });
    expect(
      await admin.change(caller("owner"), {
        emergency_admin_user_id: USERS.admin,
      }),
    ).toEqual({ settings: VIEW, sessions_revoked: 1 });

    const audit = {
      userId: USERS.owner,
      workspaceId: WORKSPACE,
      receiptId: expect.stringMatching(UUID),
    };
    expect(asked).toEqual([
      {
        method: "setPasswordLogin",
        input: { value: "emergency_only", audit },
      },
      {
        method: "setEmergencyAdmin",
        input: { userId: USERS.admin, audit },
      },
    ]);
    const receiptIds = asked.map(
      ({ input }) =>
        (input as { audit: { receiptId: string } }).audit.receiptId,
    );
    expect(new Set(receiptIds).size).toBe(2);
  });

  test("a value that was already set answers the settings and no sessions ended", async () => {
    const { admin } = service();
    expect(
      await admin.change(caller("owner"), { password_login: "on" }),
    ).toEqual({ settings: VIEW, sessions_revoked: 0 });
    expect(
      await admin.change(caller("owner"), {
        emergency_admin_user_id: USERS.owner,
      }),
    ).toEqual({ settings: VIEW, sessions_revoked: 0 });
  });

  test("each refusal of the store is a conflict that names its reason", async () => {
    for (const [method, change, reasons] of [
      [
        "setPasswordLogin",
        { password_login: "emergency_only" },
        ["no_provider", "no_emergency_admin", "locks_out_actor"],
      ],
      [
        "setEmergencyAdmin",
        { emergency_admin_user_id: USERS.admin },
        ["not_eligible", "locks_out_actor"],
      ],
    ] as const) {
      for (const reason of reasons) {
        const { admin } = service({ [method]: { outcome: reason } });
        expect(await refusal(admin.change(caller("owner"), change))).toEqual({
          code: "REVISION_CONFLICT",
          details: { reason_code: reason },
        });
      }
    }
  });

  test("a change that names both fields, or neither, reaches no store method", async () => {
    const { admin, asked } = service();
    for (const change of [
      {},
      { password_login: "on" as const, emergency_admin_user_id: USERS.owner },
    ]) {
      expect((await refusal(admin.change(caller("owner"), change))).code).toBe(
        "BAD_REQUEST",
      );
    }
    expect(asked).toEqual([]);
  });
});
