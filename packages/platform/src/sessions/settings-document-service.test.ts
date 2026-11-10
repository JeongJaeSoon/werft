import { describe, expect, test } from "bun:test";
import {
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import type {
  SettingsDocumentStore,
  SettingsImportResult,
} from "../ports/settings-document-store.ts";
import { refusal } from "../testing/refusal.ts";
import type { SettingsEntries } from "./settings-document.ts";
import { createSettingsDocumentService } from "./settings-document-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
} as const;
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";

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

const ENTRIES: SettingsEntries = {
  connections: {
    console: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key", stored: "connection:console" },
    },
  },
  connection_models: {},
  repositories: {},
  mcp_servers: {},
};

const PLAN = {
  add: [],
  unchanged: [],
  inactive: [],
  needs_value: [],
  conflicts: [],
  refused_external: [],
};

function service(result: SettingsImportResult) {
  const asked: Array<Parameters<SettingsDocumentStore["importEntries"]>> = [];
  let reread = 0;
  const store: Pick<SettingsDocumentStore, "exportEntries" | "importEntries"> =
    {
      exportEntries: async () => ({
        entries: ENTRIES,
        last4: new Map([["connection:console", "wxyz"]]),
      }),
      importEntries: async (...args) => {
        asked.push(args);
        return result;
      },
    };
  const settings = createSettingsDocumentService({
    authorization: createAuthorizationPolicy({
      agents: { agentOf: async () => null, isAdmin: async () => false },
      decisions: { record: async () => {} },
    }),
    store,
    reread: async () => {
      reread += 1;
    },
  });
  return { settings, asked, rereads: () => reread };
}

const DOCUMENT = {
  version: 1,
  connections: {
    console: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key", stored: true },
    },
  },
  repositories: {},
  mcp_servers: {},
};

describe("settings document service", () => {
  test("only a signed-in owner exports or imports: admin, member and an API key are refused", async () => {
    const { settings, asked } = service({
      ...PLAN,
      outcome: "dry_run",
      receipt_ids: [],
    });
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      expect((await refusal(settings.export(who))).code).toBe("FORBIDDEN");
      expect(
        (await refusal(settings.import(who, DOCUMENT, { dryRun: true }))).code,
      ).toBe("FORBIDDEN");
    }
    expect(asked).toEqual([]);
    const exported = await settings.export(caller("owner"));
    expect(exported.document.connections.console).toEqual({
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key", stored: true, last4: "wxyz" },
    });
    expect(exported.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(exported)).not.toContain("connection:console");
  });

  test("an owner's import never brings an external reference and names its actor", async () => {
    const { settings, asked, rereads } = service({
      ...PLAN,
      add: [
        {
          kind: "connection",
          id: "console",
          entry: ENTRIES.connections.console as never,
        },
      ],
      needs_value: ["connection:console"],
      outcome: "applied",
      receipt_ids: [RECEIPT],
    });
    const answered = await settings.import(caller("owner"), DOCUMENT, {
      dryRun: false,
    });
    expect(answered).toEqual({
      outcome: "applied",
      added: ["connection:console"],
      unchanged: [],
      inactive: [],
      needs_value: ["connection:console"],
      receipt_ids: [RECEIPT],
    });
    const [entries, options] = asked[0] ?? [];
    expect(entries).toEqual(ENTRIES);
    expect(options?.allowExternal).toBe(false);
    expect(options?.dryRun).toBe(false);
    expect(options?.actor?.userId).toBe(USERS.owner);
    expect(rereads()).toBe(1);
  });

  test("a refused plan maps to 409 for a conflict and 400 for an external reference; a bad entry is 400", async () => {
    const conflict = service({
      ...PLAN,
      conflicts: ["connection:console"],
      outcome: "refused",
      receipt_ids: [],
    });
    expect(
      await refusal(
        conflict.settings.import(caller("owner"), DOCUMENT, { dryRun: false }),
      ),
    ).toEqual({
      code: "REVISION_CONFLICT",
      details: {
        reason_code: "settings_conflict",
        entries: ["connection:console"],
      },
    });
    const external = service({
      ...PLAN,
      refused_external: ["mcp:docs"],
      outcome: "refused",
      receipt_ids: [],
    });
    expect(
      await refusal(
        external.settings.import(caller("owner"), DOCUMENT, { dryRun: false }),
      ),
    ).toEqual({
      code: "BAD_REQUEST",
      details: { reason_code: "external_reference", entries: ["mcp:docs"] },
    });
    expect(conflict.rereads() + external.rereads()).toBe(0);
    const bad = await refusal(
      conflict.settings.import(
        caller("owner"),
        {
          ...DOCUMENT,
          connections: {
            console: {
              ...DOCUMENT.connections.console,
              auth: { kind: "api_key", stored: "connection:other" },
            },
          },
        },
        { dryRun: false },
      ),
    );
    expect(bad).toEqual({
      code: "BAD_REQUEST",
      details: { reason_code: "invalid_document" },
    });
  });

  test("an owner demoted before the write commits is refused", async () => {
    const { settings } = service({ outcome: "actor_inactive" });
    expect(
      (
        await refusal(
          settings.import(caller("owner"), DOCUMENT, { dryRun: false }),
        )
      ).code,
    ).toBe("FORBIDDEN");
  });
});
