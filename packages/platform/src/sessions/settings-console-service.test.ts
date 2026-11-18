import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type { CatalogConnection } from "../catalog/catalog.ts";
import { SessionServiceError } from "../musterrolle/index.ts";
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
import {
  type OutboundHttp,
  type OutboundRequest,
  WorkspaceMcpOutboundError,
} from "../workspace-mcp/ports.ts";
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
    /** Resolved connections, by id; a function sees how many rereads ran. */
    resolved?:
      | Record<string, CatalogConnection>
      | ((rereads: number) => Record<string, CatalogConnection>);
    urlProblem?: string | null;
    http?: OutboundHttp;
  } = {},
) {
  const writes: unknown[][] = [];
  const uses: unknown[] = [];
  const logged: Record<string, unknown>[] = [];
  const sent: OutboundRequest[] = [];
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
    decideSeed: async () => {
      throw new Error("not used");
    },
    seedEntries: async () => {
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
    discovery: {
      connection: (id) => {
        const resolved =
          typeof options.resolved === "function"
            ? options.resolved(rereads)
            : options.resolved;
        return resolved?.[id];
      },
      urlProblem: () => options.urlProblem ?? null,
      http: async (request) => {
        sent.push(request);
        if (options.http === undefined) throw new Error("not used");
        return options.http(request);
      },
      log: (fields) => logged.push(fields),
    },
  });
  return { settings, writes, uses, rereads: () => rereads, logged, sent };
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
      openai_decisions: "https://api.openai.com",
    });
  });

  test("an openai_decisions connection takes OpenAI's address and an API key, and is always priced", async () => {
    const { settings, writes } = service();
    const { endpoint: _named, ...open } = NEW_CONNECTION;
    await settings.createConnection(caller("owner"), {
      ...open,
      kind: "openai_decisions",
      billing: "per_token",
    });
    expect(writes[0]?.[1]).toMatchObject({
      entry: {
        kind: "openai_decisions",
        endpoint: "https://api.openai.com",
        auth: { kind: "api_key", stored: "connection:console" },
      },
    });
    for (const refused of [
      { billing: "none" as const, endpoint: "http://luna.internal:8080" },
      { auth_kind: "bearer" as const },
    ]) {
      const { settings: again, writes: none } = service();
      const answer = await refusal(
        again.createConnection(caller("owner"), {
          ...open,
          kind: "openai_decisions",
          ...refused,
        }),
      );
      expect(answer.details, JSON.stringify(refused)).toMatchObject({
        reason_code: "invalid_entry",
      });
      expect(none).toEqual([]);
    }
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
            value: "example-bearer-1234",
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
    expect(closed.writes).toEqual([]);
  });

  test("a typed value shorter than 8 characters, or one a header cannot carry, is refused before the store", async () => {
    const { settings, writes, rereads } = service();
    const short = "1234567";
    for (const [refused, path] of [
      [
        settings.createConnection(caller("owner"), {
          ...NEW_CONNECTION,
          value: short,
        }),
        "connections.console.auth",
      ],
      [
        settings.createMcpServer(caller("owner"), {
          id: "docs",
          url: "https://mcp.example.invalid/mcp",
          credential_ref: "docs_mcp",
          workspaces: ["acme"],
          value: short,
        }),
        "mcp_servers.docs.auth",
      ],
      [
        settings.setCredential(caller("owner"), "connection", "main", short),
        "connections.main.auth",
      ],
      [
        settings.setCredential(caller("owner"), "mcp", "docs", short),
        "mcp_servers.docs.auth",
      ],
      [
        settings.setCredential(
          caller("owner"),
          "connection",
          "main",
          "example-key-1234\n",
        ),
        "connections.main.auth",
      ],
    ] as const) {
      const answer = await refusal(refused);
      expect(answer.code).toBe("BAD_REQUEST");
      expect(answer.details).toEqual({ reason_code: "invalid_entry" });
      expect(answer.message.startsWith(path)).toBe(true);
      expect(answer.message).not.toContain(short);
    }
    // Eight multi-byte characters are long enough in bytes, not in characters.
    expect(
      (
        await refusal(
          settings.setCredential(caller("owner"), "mcp", "docs", "ééééééé"),
        )
      ).details,
    ).toEqual({ reason_code: "invalid_entry" });
    expect(writes).toEqual([]);
    expect(rereads()).toBe(0);
    await settings.setCredential(caller("owner"), "mcp", "docs", "12345678");
    expect(writes).toEqual([
      ["setValue", { kind: "mcp", id: "docs" }, "12345678"],
    ]);
  });

  test("a listed connection carries no auto mode judgement", async () => {
    const { settings } = service({
      rows: {
        connection: [
          {
            id: "a",
            entry: {
              kind: "anthropic",
              endpoint: "https://api.anthropic.com",
              billing: "per_token",
              auth: { kind: "api_key", stored: true },
            },
            origin: "console" as const,
            last4: "abcd",
            createdAt: new Date("2026-10-01T00:00:00.000Z"),
            disabledAt: null,
          },
        ],
      },
    });
    const listed = await settings.listConnections(caller("owner"));
    expect(listed.items.map((item) => item.id)).toEqual(["a"]);
    expect("auto_mode" in (listed.items[0] ?? {})).toBe(false);
    expect("setConnectionAutoMode" in settings).toBe(false);
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

  test("a list sent without model_families leaves the stored series alone; an explicit null clears them", async () => {
    const { settings, writes } = service({
      rows: { connection: [connectionRow("console")] },
    });
    await settings.setConnectionModels(caller("owner"), "console", {
      models: ["a"],
    });
    await settings.setConnectionModels(caller("owner"), "console", {
      models: ["a"],
      model_families: null,
    });
    expect(writes).toEqual([
      ["setConnectionModels", "console", { models: ["a"] }],
      [
        "setConnectionModels",
        "console",
        { models: ["a"], model_families: null },
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

describe("reading a connection's models from its provider", () => {
  const KEY = "example-model-key";
  const resolved = (
    endpoint = "https://api.anthropic.invalid",
  ): CatalogConnection => ({
    provider: {
      kind: "anthropic",
      endpoint,
      auth: {
        kind: "api_key",
        value: KEY,
        ref: { stored: "connection:console" },
      },
    },
    models: [],
  });
  const listing = async () => ({
    status: 200,
    headers: new Headers(),
    text: JSON.stringify({
      data: [
        { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
        { id: "claude-haiku-5", display_name: "Claude Haiku 5" },
      ],
      has_more: false,
    }),
  });

  test("only the signed-in owner asks, and nothing is sent for anyone else", async () => {
    const { settings, sent } = service({
      rows: { connection: [connectionRow("console")] },
      resolved: { console: resolved() },
      http: listing,
    });
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      expect(
        (await refusal(settings.discoverConnectionModels(who, "console"))).code,
      ).toBe("FORBIDDEN");
    }
    expect(sent).toEqual([]);
  });

  test("marks the saved models, lists the ones the provider dropped, writes nothing and logs counts only", async () => {
    const { settings, writes, sent, logged } = service({
      rows: {
        connection: [
          connectionRow("console", {
            models: ["claude-retired-4", "claude-haiku-5"],
          }),
        ],
      },
      resolved: { console: resolved("https://api.anthropic.invalid/") },
      http: listing,
    });
    const answered = await settings.discoverConnectionModels(
      caller("owner"),
      "console",
    );
    expect(answered).toEqual({
      models: [
        {
          id: "claude-sonnet-5",
          display_name: "Claude Sonnet 5",
          selected: false,
        },
        {
          id: "claude-haiku-5",
          display_name: "Claude Haiku 5",
          selected: true,
        },
      ],
      missing: ["claude-retired-4"],
      skipped: 0,
      truncated: false,
    });
    expect(sent.map((request) => request.url)).toEqual([
      "https://api.anthropic.invalid/v1/models?limit=1000",
    ]);
    expect(writes).toEqual([]);
    expect(logged).toEqual([
      {
        connection_id: "console",
        outcome: "listed",
        models: 2,
        skipped: 0,
        missing: 1,
        truncated: false,
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain(KEY);
  });

  test("each state refuses before anything is sent", async () => {
    const cases: Array<{
      rows: SettingsRow[];
      leftOut?: string[];
      resolved?: Record<string, CatalogConnection>;
      code: string;
      reason?: string;
    }> = [
      { rows: [], code: "NOT_FOUND" },
      {
        rows: [
          connectionRow("console", {
            entry: {
              kind: "openai_decisions",
              endpoint: "https://api.openai.invalid",
              auth: { kind: "api_key", stored: "connection:console" },
            },
          }),
        ],
        code: "REVISION_CONFLICT",
        reason: "kind_unsupported",
      },
      {
        rows: [connectionRow("console", { disabledAt: AT })],
        code: "REVISION_CONFLICT",
        reason: "disabled",
      },
      {
        rows: [connectionRow("console", { last4: null })],
        code: "REVISION_CONFLICT",
        reason: "needs_value",
      },
      {
        rows: [connectionRow("console")],
        leftOut: ["connection:console"],
        code: "BACKEND_UNAVAILABLE",
        reason: "credential_unresolved",
      },
    ];
    for (const item of cases) {
      const { settings, sent } = service({
        rows: { connection: item.rows },
        ...(item.leftOut === undefined ? {} : { leftOut: item.leftOut }),
        resolved: item.resolved ?? {},
        http: listing,
      });
      const refused = await refusal(
        settings.discoverConnectionModels(caller("owner"), "console"),
      );
      expect([
        refused.code,
        (refused.details as { reason_code?: string } | undefined)?.reason_code,
      ]).toEqual([item.code, item.reason]);
      expect(sent).toEqual([]);
    }
  });

  test("a connection this replica has not read yet is read again once", async () => {
    const { settings, rereads } = service({
      rows: { connection: [connectionRow("console")] },
      resolved: (count) => (count === 0 ? {} : { console: resolved() }),
      http: listing,
    });
    const answered = await settings.discoverConnectionModels(
      caller("owner"),
      "console",
    );
    expect(answered.models).toHaveLength(2);
    expect(rereads()).toBe(1);
  });

  test("an endpoint outside the API's credential allowlist is refused closed", async () => {
    for (const problem of [
      "credential_allowlist_unset",
      "host_not_allowed",
      "url_insecure",
    ]) {
      const { settings, sent } = service({
        rows: { connection: [connectionRow("console")] },
        resolved: { console: resolved() },
        urlProblem: problem,
        http: listing,
      });
      const refused = await refusal(
        settings.discoverConnectionModels(caller("owner"), "console"),
      );
      expect(refused.code).toBe("BAD_REQUEST");
      expect(refused.details).toEqual({ reason_code: problem });
      expect(sent).toEqual([]);
    }
  });

  test("the provider's refusals map to a code and reason, never carrying the key or body", async () => {
    const cases: Array<[OutboundHttp, string, string, number | undefined]> = [
      [
        async () => ({ status: 401, headers: new Headers(), text: KEY }),
        "BAD_REQUEST",
        "provider_unauthorized",
        401,
      ],
      [
        async () => ({ status: 307, headers: new Headers(), text: "" }),
        "BAD_REQUEST",
        "provider_answered",
        307,
      ],
      [
        async () => {
          throw new WorkspaceMcpOutboundError("unreachable", "refused");
        },
        "BACKEND_UNAVAILABLE",
        "provider_unreachable",
        undefined,
      ],
      [
        async () => {
          throw new WorkspaceMcpOutboundError("address_not_allowed", "private");
        },
        "BAD_REQUEST",
        "address_not_allowed",
        undefined,
      ],
      [
        async () => ({ status: 200, headers: new Headers(), text: "not json" }),
        "BACKEND_UNAVAILABLE",
        "provider_failed",
        undefined,
      ],
      [
        async () => ({
          status: 200,
          headers: new Headers(),
          text: JSON.stringify({ data: [{ id: KEY }] }),
        }),
        "BAD_REQUEST",
        "credential_reflected",
        undefined,
      ],
    ];
    for (const [http, code, reason, status] of cases) {
      const { settings, logged } = service({
        rows: { connection: [connectionRow("console")] },
        resolved: { console: resolved() },
        http,
      });
      const refused = await refusal(
        settings.discoverConnectionModels(caller("owner"), "console"),
      );
      expect<string>(refused.code).toBe(code);
      expect(refused.details).toEqual({
        reason_code: reason,
        ...(status === undefined ? {} : { provider_status: status }),
      });
      expect(refused.message).not.toContain(KEY);
      expect(JSON.stringify(logged)).not.toContain(KEY);
      expect(logged).toEqual([
        {
          connection_id: "console",
          outcome: reason,
          provider_status: status ?? null,
        },
      ]);
    }
  });
});

describe("a repository's own GitHub App key", () => {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const repositoryRow = (id: string, auth: unknown): SettingsRow => ({
    id,
    entry: { url: "https://github.example/acme/app", branch: "main", auth },
    origin: "import",
    last4: "----",
    createdAt: AT,
    disabledAt: null,
  });
  const rows = {
    repository: [
      repositoryRow("platform-app", {
        kind: "github_app",
        app_id: 7,
        installation_id: 8,
        api_base: "https://github.example/api/v3",
        stored: "repository:platform-app",
      }),
      repositoryRow("console-app", { kind: "github_app" }),
      repositoryRow("url-repo", {
        kind: "bearer",
        stored: "repository:url-repo",
      }),
    ],
  };

  test("an owner or an admin replaces it with an RSA private key, which reaches the store and not the answer", async () => {
    for (const who of ["owner", "admin"] as const) {
      const { settings, writes } = service({ rows });
      const changed = await settings.setCredential(
        caller(who),
        "repository",
        "platform-app",
        pem.replace(/\n/g, "\r\n"),
      );
      expect(changed).toEqual({ id: "platform-app", receipt_id: RECEIPT });
      expect(writes).toEqual([
        ["setValue", { kind: "repository", id: "platform-app" }, pem.trim()],
      ]);
    }
  });

  test("a member or an API key is refused and nothing is written", async () => {
    const { settings, writes } = service({ rows });
    for (const who of [caller("member"), apiKey]) {
      expect(
        (
          await refusal(
            settings.setCredential(who, "repository", "platform-app", pem),
          )
        ).code,
      ).toBe("FORBIDDEN");
    }
    expect(writes).toEqual([]);
  });

  test("anything but an RSA private key is 400 invalid_private_key, never echoed", async () => {
    const { settings, writes } = service({ rows });
    const value = "example-not-a-key-1234";
    const refused = await refusal(
      settings.setCredential(
        caller("owner"),
        "repository",
        "platform-app",
        value,
      ),
    );
    expect(refused.code).toBe("BAD_REQUEST");
    expect(refused.details).toEqual({ reason_code: "invalid_private_key" });
    expect(JSON.stringify(refused)).not.toContain(value);
    expect(writes).toEqual([]);
  });

  test("a URL repository, one on the console's App or an unknown id is 404", async () => {
    const { settings, writes } = service({ rows });
    for (const id of ["url-repo", "console-app", "missing"]) {
      expect(
        (
          await refusal(
            settings.setCredential(caller("owner"), "repository", id, pem),
          )
        ).code,
      ).toBe("NOT_FOUND");
    }
    expect(writes).toEqual([]);
  });
});
