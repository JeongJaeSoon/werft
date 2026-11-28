import { describe, expect, test } from "bun:test";
import { createLinkedAccountService } from "./linked-account-service.ts";
import { callerFor, createAuthorizationPolicy } from "./policy.ts";
import type {
  LinkAccountResult,
  LinkedAccountRecord,
  LinkedAccountStore,
} from "./ports/linked-account-store.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const PERSON = "019a0000-0000-7000-8000-0000000000a1";
const KEY = "019a0000-0000-7000-8000-0000000000c1";
const LINK = "019a0000-0000-7000-8000-0000000000d1";

const record: LinkedAccountRecord = {
  id: LINK,
  workspaceId: WORKSPACE,
  userId: PERSON,
  provider: "slack",
  externalTenant: "T0TEAM",
  externalUserId: "U0USER",
  externalTenantName: "Acme",
  externalUserName: null,
  status: "active",
  verifiedAt: new Date("2026-10-11T00:00:00Z"),
  revision: 1,
};

function serviceWith(overrides: Partial<LinkedAccountStore> = {}) {
  const calls: unknown[] = [];
  const store: LinkedAccountStore = {
    installedSlackTeams: async () => ["T0TEAM"],
    link: async (input) => {
      calls.push(input);
      return { outcome: "linked", account: record, receiptId: LINK };
    },
    unlink: async (input) => {
      calls.push(input);
      return { outcome: "unlinked", receiptId: LINK };
    },
    list: async (workspaceId, userId, limit) => {
      calls.push({ workspaceId, userId, limit });
      return [record];
    },
    resolveLinkedSubject: async () => ({ status: "unlinked" }),
    markStale: async () => ({ outcome: "not_found" }),
    ...overrides,
  };
  return {
    service: createLinkedAccountService({
      authorization: createAuthorizationPolicy(),
      store,
    }),
    calls,
  };
}

const asPerson = (role: "owner" | "member" = "member") =>
  callerFor(
    {
      kind: "user",
      id: PERSON,
      workspace_id: WORKSPACE,
      role,
      scopes: ["sessions:read"],
    },
    { kind: "web" },
    crypto.randomUUID(),
  );

const asPersonalKey = () =>
  callerFor(
    {
      kind: "api_key",
      id: KEY,
      owner_id: WORKSPACE,
      workspace_id: WORKSPACE,
      scopes: ["sessions:read", "sessions:write"],
    },
    { kind: "api" },
    crypto.randomUUID(),
    { creatorId: PERSON },
  );

describe("linking a Slack account", () => {
  test("owners and members link their own account; keys cannot, not even personal ones", async () => {
    const { service } = serviceWith();
    for (const role of ["owner", "member"] as const) {
      expect(await service.beginSlackLink(asPerson(role))).toEqual({
        userId: PERSON,
        teams: ["T0TEAM"],
      });
    }
    await expect(service.beginSlackLink(asPersonalKey())).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    await expect(service.personFor(asPersonalKey())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  test("a workspace with no verified Slack install is refused before Slack is shown", async () => {
    const { service } = serviceWith({ installedSlackTeams: async () => [] });
    await expect(service.beginSlackLink(asPerson())).rejects.toMatchObject({
      code: "SLACK_NOT_INSTALLED",
    });
  });

  test("links the verified account to the caller, never to a person named elsewhere", async () => {
    const { service, calls } = serviceWith();
    expect(
      await service.linkSlackAccount(asPerson(), {
        teamId: "T0TEAM",
        userId: "U0USER",
        teamName: "Acme",
        userName: null,
      }),
    ).toEqual({
      linked_account: {
        id: LINK,
        user_id: PERSON,
        provider: "slack",
        external_tenant: "T0TEAM",
        external_user_id: "U0USER",
        external_tenant_name: "Acme",
        external_user_name: null,
        status: "active",
        verified_at: "2026-10-11T00:00:00.000Z",
        revision: 1,
        expires_at: null,
      },
      receipt_id: LINK,
    });
    expect(calls).toMatchObject([
      {
        workspaceId: WORKSPACE,
        userId: PERSON,
        account: {
          provider: "slack",
          externalTenant: "T0TEAM",
          externalUserId: "U0USER",
        },
        names: { externalTenantName: "Acme", externalUserName: null },
      },
    ]);
  });

  test("each refusal from the store has its own code and guidance", async () => {
    const cases: [LinkAccountResult, string, RegExp][] = [
      [{ outcome: "not_installed" }, "SLACK_NOT_INSTALLED", /설치/],
      [
        { outcome: "team_mismatch", workspaceName: "Acme" },
        "LINK_TEAM_MISMATCH",
        /Acme 워크스페이스/,
      ],
      [{ outcome: "taken" }, "LINK_TAKEN", /다른 사용자/],
      [{ outcome: "exists" }, "LINK_EXISTS", /이미 연결/],
      [{ outcome: "actor_inactive" }, "FORBIDDEN", /no longer a member/],
    ];
    for (const [result, code, message] of cases) {
      const { service } = serviceWith({ link: async () => result });
      const refusal = service.linkSlackAccount(asPerson(), {
        teamId: "T0TEAM",
        userId: "U0USER",
        teamName: null,
        userName: null,
      });
      await expect(refusal).rejects.toMatchObject({ code });
      await expect(refusal).rejects.toThrow(message);
    }
  });
});

describe("listing and unlinking", () => {
  test("lists only the caller's own links", async () => {
    const { service, calls } = serviceWith();
    expect((await service.listLinkedAccounts(asPerson())).items).toHaveLength(
      1,
    );
    expect(calls).toEqual([
      { workspaceId: WORKSPACE, userId: PERSON, limit: 50 },
    ]);
  });

  test("unlinks the caller's link, and a link that is not theirs does not exist", async () => {
    const { service, calls } = serviceWith();
    expect(await service.unlinkAccount(asPerson(), LINK)).toEqual({
      receipt_id: LINK,
      receipt_status: "succeeded",
    });
    expect(calls).toMatchObject([
      { workspaceId: WORKSPACE, userId: PERSON, linkedAccountId: LINK },
    ]);
    const { service: missing } = serviceWith({
      unlink: async () => ({ outcome: "not_found" }),
    });
    await expect(missing.unlinkAccount(asPerson(), LINK)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await expect(
      service.unlinkAccount(asPersonalKey(), LINK),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
