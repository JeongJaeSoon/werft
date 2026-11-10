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
  SettingsConsoleResult,
  SettingsDocumentStore,
  SettingsRow,
} from "../ports/settings-document-store.ts";
import { SessionServiceError } from "./session-service.ts";
import { createSettingsConsoleService } from "./settings-console-service.ts";
import type { SettingsKind } from "./settings-document.ts";

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

const AT = new Date("2026-11-04T03:00:00.000Z");
const connectionRow = (
  id: string,
  over: Partial<SettingsRow> = {},
): SettingsRow => ({
  id,
  entry: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", stored: `connection:${id}` },
  },
  origin: "console",
  last4: "wxyz",
  createdAt: AT,
  disabledAt: null,
  ...over,
});

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      return {
        code: error.code,
        details: error.details,
        message: error.message,
      };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

function service(
  options: {
    rows?: Partial<Record<SettingsKind, SettingsRow[]>>;
    result?: SettingsConsoleResult;
    secretStoreOn?: boolean;
    leftOut?: string[];
    use?: { agents: number; sessions: number; judgeNamed: boolean };
  } = {},
) {
  const writes: unknown[][] = [];
  const uses: unknown[] = [];
  let rereads = 0;
  const result = options.result ?? { outcome: "done", receiptId: RECEIPT };
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      writes.push([name, ...args.slice(0, -1)]);
      return result;
    };
  const store: SettingsDocumentStore = {
    exportEntries: async () => {
      throw new Error("not used");
    },
    importEntries: async () => {
      throw new Error("not used");
    },
    sessionsOnRepositories: async () => [],
    connectionUse: async (input) => {
      uses.push(input);
      return options.use ?? { agents: 0, sessions: 0, judgeNamed: false };
    },
    listRows: async (kind) => options.rows?.[kind] ?? [],
    create: record("create"),
    setValue: record("setValue"),
    convertConnection: record("convertConnection"),
    setConnectionAutoMode: record("setConnectionAutoMode"),
    setConnectionModels: record("setConnectionModels"),
    disable: record("disable"),
    enableConnection: record("enableConnection"),
    setMcpWorkspaces: record("setMcpWorkspaces"),
  };
  const settings = createSettingsConsoleService({
    authorization: createAuthorizationPolicy({
      agents: { agentOf: async () => null, isAdmin: async () => false },
      decisions: { record: async () => {} },
    }),
    store,
    leftOut: () => (options.leftOut ?? []).map((entry) => ({ entry })),
    secretStoreOn: options.secretStoreOn ?? true,
    credentialHosts: ["api.anthropic.com:443"],
    reread: async () => {
      rereads += 1;
    },
  });
  return { settings, writes, uses, rereads: () => rereads };
}


const NEW_CONNECTION = {
  id: "console",
  kind: "anthropic" as const,
  endpoint: "https://api.anthropic.invalid",
  auth_kind: "api_key" as const,
  value: "example-key-1234",
};

describe("settings console service", () => {
  test("connections and MCP servers are the signed-in owner's", async () => {
    const { settings, writes } = service();
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      expect((await refusal(settings.listConnections(who))).code).toBe(
        "FORBIDDEN",
      );
      expect((await refusal(settings.listMcpServers(who))).code).toBe(
        "FORBIDDEN",
      );
      expect(
        (await refusal(settings.createConnection(who, NEW_CONNECTION))).code,
      ).toBe("FORBIDDEN");
      expect((await refusal(settings.disable(who, "mcp", "docs"))).code).toBe(
        "FORBIDDEN",
      );
      expect(
        (await refusal(settings.setCredential(who, "connection", "c", "v")))
          .code,
      ).toBe("FORBIDDEN");
      expect(
        (await refusal(settings.convertConnection(who, "c", "v"))).code,
      ).toBe("FORBIDDEN");
      expect(
        (await refusal(settings.setConnectionAutoMode(who, "c", "supported")))
          .code,
      ).toBe("FORBIDDEN");
    }
    expect(writes).toEqual([]);
  });

  test("a connection is made stored under its own id, with the typed value, then the settings are read again", async () => {
    const { settings, writes, rereads } = service();
    const made = await settings.createConnection(caller("owner"), {
      ...NEW_CONNECTION,
      billing: "none",
    });
    expect(made).toEqual({ id: "console", receipt_id: RECEIPT });
    expect(writes).toEqual([
      [
        "create",
        {
          kind: "connection",
          id: "console",
          entry: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            billing: "none",
            auth: { kind: "api_key", stored: "connection:console" },
          },
        },
        "example-key-1234",
      ],
    ]);
    expect(rereads()).toBe(1);
  });

  test("an empty endpoint is stored as the kind's default; a kind with none, or billing none on it, is refused", async () => {
    for (const endpoint of [undefined, "", "  "]) {
      const { settings, writes } = service();
      const { endpoint: _named, ...open } = NEW_CONNECTION;
      await settings.createConnection(caller("owner"), {
        ...open,
        ...(endpoint === undefined ? {} : { endpoint }),
      });
      expect(writes[0]?.[1]).toMatchObject({
        entry: { kind: "anthropic", endpoint: "https://api.anthropic.com" },
      });
    }
    const { settings, writes } = service();
    const { endpoint: _named, ...open } = NEW_CONNECTION;
    for (const endpoint of [undefined, "", "  "]) {
      const litellm = await refusal(
        settings.createConnection(caller("owner"), {
          ...open,
          ...(endpoint === undefined ? {} : { endpoint }),
          kind: "litellm",
        }),
      );
      expect(litellm.code).toBe("BAD_REQUEST");
      expect(litellm.details).toMatchObject({ reason_code: "invalid_entry" });
      expect(litellm.message).toContain("connections.console.endpoint");
      expect(litellm.message).toContain("litellm connection needs an endpoint");
      expect(litellm.message).not.toContain("Invalid input");
    }
    const paid = await refusal(
      settings.createConnection(caller("owner"), {
        ...open,
        billing: "none",
      }),
    );
    expect(paid.details).toMatchObject({ reason_code: "invalid_entry" });
    expect(writes).toEqual([]);
  });

  test("the list names each kind's default endpoint", async () => {
    const { settings } = service();
    expect(
      (await settings.listConnections(caller("owner"))).endpoint_defaults,
    ).toEqual({
      anthropic: "https://api.anthropic.com",
      openai_responses: "https://api.openai.com",
    });
  });

  test("an entry the catalog refuses and a closed secret store are refused before the store", async () => {
    const { settings, writes } = service();
    const bad = await refusal(
      settings.createConnection(caller("owner"), {
        ...NEW_CONNECTION,
        endpoint: "ftp://models.invalid",
      }),
    );
    expect(bad.code).toBe("BAD_REQUEST");
    expect(bad.details).toMatchObject({ reason_code: "invalid_entry" });
    // Anthropic takes only an api_key.
    expect(
      (
        await refusal(
          settings.createConnection(caller("owner"), {
            ...NEW_CONNECTION,
            auth_kind: "bearer",
          }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    expect(
      (
        await refusal(
          settings.createMcpServer(caller("owner"), {
            id: "github",
            url: "https://mcp.example.invalid/mcp",
            credential_ref: "docs_mcp",
            workspaces: ["acme"],
            value: "v",
          }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    expect(
      (
        await refusal(
          settings.setMcpWorkspaces(caller("owner"), "docs", ["a", "a"]),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    expect(writes).toEqual([]);

    const closed = service({ secretStoreOn: false });
    expect(
      (
        await refusal(
          closed.settings.createConnection(caller("owner"), NEW_CONNECTION),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    expect(
      (
        await refusal(
          closed.settings.setCredential(caller("owner"), "mcp", "docs", "v"),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    expect(
      (
        await refusal(
          closed.settings.convertConnection(caller("owner"), "main", "v"),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    expect(closed.writes).toEqual([]);
  });

  test("moving a connection to a stored value passes the typed value and rereads", async () => {
    const { settings, writes, rereads } = service();
    const moved = await settings.convertConnection(
      caller("owner"),
      "main",
      "typed-key-value",
    );
    expect(moved).toEqual({ id: "main", receipt_id: RECEIPT });
    expect(writes).toEqual([["convertConnection", "main", "typed-key-value"]]);
    expect(rereads()).toBe(1);
  });

  test("a connection's auto mode is passed to the store and the settings are read again", async () => {
    const { settings, writes, rereads } = service();
    const set = await settings.setConnectionAutoMode(
      caller("owner"),
      "main",
      "supported",
    );
    expect(set).toEqual({ id: "main", receipt_id: RECEIPT });
    expect(writes).toEqual([["setConnectionAutoMode", "main", "supported"]]);
    expect(rereads()).toBe(1);
  });

  test("the list names each connection's judged auto mode, unknown when the store has none", async () => {
    const entry = {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      billing: "per_token",
      auth: { kind: "api_key", stored: true },
    };
    const row = (id: string, autoMode?: "supported" | "unsupported") => ({
      id,
      entry,
      origin: "console" as const,
      last4: "abcd",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      disabledAt: null,
      ...(autoMode === undefined ? {} : { autoMode }),
    });
    const { settings } = service({
      rows: {
        connection: [row("a", "supported"), row("b", "unsupported"), row("c")],
      },
    });
    const listed = await settings.listConnections(caller("owner"));
    expect(listed.items.map((item) => [item.id, item.auto_mode])).toEqual([
      ["a", "supported"],
      ["b", "unsupported"],
      ["c", "unknown"],
    ]);
  });

  test("the store's refusals map to their codes and reason", async () => {
    for (const [result, code, reason] of [
      [{ outcome: "actor_inactive" }, "FORBIDDEN", "role"],
      [{ outcome: "not_found" }, "NOT_FOUND", undefined],
      [
        { outcome: "conflict", reason: "already_exists" },
        "REVISION_CONFLICT",
        "already_exists",
      ],
      [
        { outcome: "conflict", reason: "not_stored" },
        "REVISION_CONFLICT",
        "not_stored",
      ],
      [
        { outcome: "conflict", reason: "disabled" },
        "REVISION_CONFLICT",
        "disabled",
      ],
      [
        { outcome: "conflict", reason: "not_external" },
        "REVISION_CONFLICT",
        "not_external",
      ],
      [
        { outcome: "conflict", reason: "alias_taken" },
        "REVISION_CONFLICT",
        "alias_taken",
      ],
    ] as const) {
      const { settings, rereads } = service({ result });
      const refused = await refusal(
        settings.disable(caller("owner"), "connection", "console"),
      );
      expect(refused.code).toBe(code);
      if (reason !== undefined) {
        expect(refused.details).toMatchObject({ reason_code: reason });
      }
      expect(rereads()).toBe(0);
    }
  });

  test("enabling a connection is the owner's, writes through the store and rereads", async () => {
    const { settings, writes, rereads } = service();
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      expect(
        (await refusal(settings.enableConnection(who, "console"))).code,
      ).toBe("FORBIDDEN");
    }
    expect(writes).toEqual([]);
    expect(rereads()).toBe(0);
    expect(await settings.enableConnection(caller("owner"), "console")).toEqual(
      { id: "console", receipt_id: RECEIPT },
    );
    expect(writes).toEqual([["enableConnection", "console"]]);
    expect(rereads()).toBe(1);
  });

  test("an enable the store refuses says why, and the settings are not read again", async () => {
    for (const [result, code, reason, message] of [
      [{ outcome: "actor_inactive" }, "FORBIDDEN", "role", undefined],
      [{ outcome: "not_found" }, "NOT_FOUND", undefined, undefined],
      [
        { outcome: "conflict", reason: "not_disabled" },
        "REVISION_CONFLICT",
        "not_disabled",
        "is not disabled",
      ],
      [
        { outcome: "conflict", reason: "definition_active" },
        "REVISION_CONFLICT",
        "definition_active",
        "another connection in use",
      ],
      [
        { outcome: "conflict", reason: "needs_value" },
        "REVISION_CONFLICT",
        "needs_value",
        "stored value is gone",
      ],
    ] as const) {
      const { settings, rereads } = service({ result });
      const refused = await refusal(
        settings.enableConnection(caller("owner"), "console"),
      );
      expect(refused.code).toBe(code);
      if (reason !== undefined) {
        expect(refused.details).toMatchObject({ reason_code: reason });
      }
      if (message !== undefined) expect(refused.message).toContain(message);
      expect(rereads()).toBe(0);
    }
  });

  test("the list tells each row's state; never a value", async () => {
    const { settings } = service({
      rows: {
        connection: [
          connectionRow("console"),
          connectionRow("empty", { last4: null }),
          connectionRow("off", { disabledAt: AT }),
          connectionRow("fake", { origin: "import" }),
          connectionRow("broken"),
        ],
      },
      leftOut: ["connection:broken"],
    });
    const listed = await settings.listConnections(caller("owner"));
    expect(listed.credential_hosts).toEqual(["api.anthropic.com:443"]);
    expect(
      listed.items.map((item) => [item.id, item.origin, item.state]),
    ).toEqual([
      ["broken", "console", "unresolved"],
      ["console", "console", "active"],
      ["empty", "console", "needs_value"],
      ["fake", "import", "active"],
      ["off", "console", "disabled"],
    ]);
    expect(listed.items.find((item) => item.id === "console")).toMatchObject({
      credential: { source: "stored", last4: "wxyz" },
      created_at: AT.toISOString(),
    });
    expect(JSON.stringify(listed)).not.toContain("connection:console");
  });
});

describe("what disabling a connection would leave without a model", () => {
  const rows = { connection: [connectionRow("console")] };

  test("only the signed-in owner asks, and a refusal reads nothing", async () => {
    const { settings, uses } = service({ rows });
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      expect(
        (await refusal(settings.connectionImpact(who, "console"))).code,
      ).toBe("FORBIDDEN");
    }
    expect(uses).toEqual([]);
  });

  test("an id the console does not hold is not found, and nothing is counted", async () => {
    const { settings, uses } = service({ rows });
    expect(
      (await refusal(settings.connectionImpact(caller("owner"), "other"))).code,
    ).toBe("NOT_FOUND");
    expect(uses).toEqual([]);
  });

  test("what runs on the connection comes back as counts only", async () => {
    const { settings, uses } = service({
      rows,
      use: { agents: 3, sessions: 2, judgeNamed: true },
    });
    const impact = await settings.connectionImpact(caller("owner"), "console");
    expect(impact).toEqual({
      id: "console",
      agent_count: 3,
      session_count: 2,
      judge_used: true,
    });
    expect(uses).toEqual([{ connectionId: "console" }]);
  });
});

describe("a connection's models", () => {
  test("only the signed-in owner sets them", async () => {
    const { settings, writes } = service({
      rows: { connection: [connectionRow("console")] },
    });
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      expect(
        (
          await refusal(
            settings.setConnectionModels(who, "console", { models: ["m"] }),
          )
        ).code,
      ).toBe("FORBIDDEN");
    }
    expect(writes).toEqual([]);
  });

  test("are written with their series, and a repeat or a shared rank is refused", async () => {
    const { settings, writes } = service({
      rows: { connection: [connectionRow("console")] },
    });
    for (const request of [
      { models: ["a", "a"] },
      {
        models: ["a", "b"],
        model_families: {
          a: { family: "f", rank: 1 },
          b: { family: "f", rank: 1 },
        },
      },
    ]) {
      expect(
        (
          await refusal(
            settings.setConnectionModels(caller("owner"), "console", request),
          )
        ).code,
      ).toBe("BAD_REQUEST");
    }
    expect(writes).toEqual([]);
    await settings.setConnectionModels(caller("owner"), "console", {
      models: ["a", "b"],
      model_families: { a: { family: "f", rank: 1 } },
    });
    expect(writes).toEqual([
      [
        "setConnectionModels",
        "console",
        { models: ["a", "b"], model_families: { a: { family: "f", rank: 1 } } },
      ],
    ]);
  });

  test("are listed with the connection", async () => {
    const { settings } = service({
      rows: {
        connection: [
          connectionRow("console", {
            models: ["claude-sonnet-5"],
            modelFamilies: { "claude-sonnet-5": { family: "sonnet", rank: 5 } },
          }),
          connectionRow("bare"),
        ],
      },
    });
    const listed = await settings.listConnections(caller("owner"));
    expect(
      listed.items.map((item) => [item.id, item.models, item.model_families]),
    ).toEqual([
      ["bare", [], null],
      [
        "console",
        ["claude-sonnet-5"],
        { "claude-sonnet-5": { family: "sonnet", rank: 5 } },
      ],
    ]);
  });
});
