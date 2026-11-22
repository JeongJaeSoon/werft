import { describe, expect, test } from "bun:test";
import {
  type ExistingSettings,
  parseSettingsDocument,
  planSettingsImport,
  repositoryNameOf,
  SettingsDocumentError,
  settingsDocumentDigest,
  settingsDocumentOf,
} from "./settings-document.ts";

const DOCUMENT = {
  version: 1,
  connections: {
    main: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key", stored: true },
    },
    console: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key", stored: true, last4: "wxyz" },
    },
  },
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "main",
      auth: { kind: "github_app" },
    },
    open: {
      url: "https://github.com/acme/open.git",
      branch: "main",
      auth: { kind: "github_app" },
    },
  },
};

const CATALOG_MCP = {
  url: "https://mcp.example.invalid/docs",
  credential_ref: "docs_token",
  auth: { kind: "bearer", stored: true },
  workspaces: ["acme"],
};

const NONE: ExistingSettings = {
  connections: new Map(),
  repositories: new Map(),
  stored_values: new Set(),
};

describe("parseSettingsDocument", () => {
  test("binds a stored entry to its own row and drops last4", () => {
    const entries = parseSettingsDocument(DOCUMENT);
    expect(entries.connections.console?.auth).toEqual({
      kind: "api_key",
      stored: "connection:console",
    });
    expect(entries.connections.main?.auth).toEqual({
      kind: "api_key",
      stored: "connection:main",
    });
  });

  test("a document naming an installation catalog MCP server is refused whole, by name only; an empty or missing field is taken", () => {
    for (const servers of [
      { docs: CATALOG_MCP },
      { wiki: CATALOG_MCP, docs: CATALOG_MCP },
    ]) {
      const refused = (() => {
        try {
          parseSettingsDocument({ ...DOCUMENT, mcp_servers: servers });
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(refused).toBeInstanceOf(SettingsDocumentError);
      const message = (refused as Error).message;
      expect(message).toBe(
        `The settings document is invalid: mcp_servers (${Object.keys(servers).sort().join(", ")}): 설치 카탈로그 MCP는 없어졌다. 워크스페이스 MCP 서버로 등록해 고른다`,
      );
      expect(message).not.toContain("mcp.example.invalid");
      expect(message).not.toContain("docs_token");
    }
    const { mcp_servers: _none, ...missing } = {
      ...DOCUMENT,
      mcp_servers: {},
    };
    expect(parseSettingsDocument({ ...DOCUMENT, mcp_servers: {} })).toEqual(
      parseSettingsDocument(missing),
    );
  });

  test("an export has no mcp_servers field", () => {
    expect(
      settingsDocumentOf(parseSettingsDocument(DOCUMENT)),
    ).not.toHaveProperty("mcp_servers");
  });

  test("refuses an env or Secrets Manager reference, naming the field", () => {
    const main = DOCUMENT.connections.main;
    for (const [field, section, id, entry] of [
      ["value_env", "connections", "main", main],
      ["secret_id", "connections", "main", main],
    ] as const) {
      const document = {
        ...DOCUMENT,
        [section]: {
          [id]: { ...entry, auth: { ...entry.auth, [field]: "NAME" } },
        },
      };
      expect(() => parseSettingsDocument(document)).toThrow(
        new SettingsDocumentError(
          `${section}.${id}.auth.${field} is no longer supported: write "stored": true and set the value in the console`,
        ),
      );
    }
    // Without `stored` beside it, too.
    expect(() =>
      parseSettingsDocument({
        version: 1,
        connections: {
          c: {
            kind: "anthropic",
            auth: { kind: "api_key", value_env: "ANTHROPIC_API_KEY" },
          },
        },
      }),
    ).toThrow("connections.c.auth.value_env is no longer supported");
  });

  test("refuses a stored reference naming any row, its own included", () => {
    for (const stored of ["connection:main", "connection:console", "yes"]) {
      expect(() =>
        parseSettingsDocument({
          ...DOCUMENT,
          connections: {
            console: {
              kind: "anthropic",
              endpoint: "https://api.anthropic.invalid",
              auth: { kind: "api_key", stored },
            },
          },
        }),
      ).toThrow(SettingsDocumentError);
    }
  });

  test("a profiles block from before their removal says what to do", () => {
    expect(() => parseSettingsDocument({ ...DOCUMENT, profiles: {} })).toThrow(
      /`profiles` is no longer part of a settings document.*connections\.<id>\.models/,
    );
  });

  test("holds the file catalog's rules", () => {
    for (const bad of [
      { ...DOCUMENT, version: 2 },
      // A document from before profiles were removed.
      { ...DOCUMENT, profiles: {} },
      {
        ...DOCUMENT,
        repositories: {
          leaky: {
            url: "https://u:p@github.com/a/b.git",
            branch: "main",
            auth: { kind: "github_app" },
          },
        },
      },
      ...[
        undefined,
        { kind: "none" },
        { kind: "basic", username: "bot", stored: true },
        { kind: "bearer", stored: true },
      ].map((auth) => ({
        ...DOCUMENT,
        repositories: {
          removed: {
            url: "https://git.example.invalid/a/b.git",
            branch: "main",
            auth,
          },
        },
      })),
    ]) {
      expect(() => parseSettingsDocument(bad)).toThrow(SettingsDocumentError);
    }
  });

  test("exports back to the document it read, digest and all", () => {
    const entries = parseSettingsDocument(DOCUMENT);
    const exported = settingsDocumentOf(
      entries,
      new Map([["connection:console", "wxyz"]]),
    );
    expect(exported).toEqual(DOCUMENT as typeof exported);
    expect(parseSettingsDocument(exported)).toEqual(entries);
    expect(settingsDocumentDigest(exported)).toBe(
      settingsDocumentDigest(structuredClone(DOCUMENT) as typeof exported),
    );
    expect(settingsDocumentDigest(exported)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("an entry with no endpoint takes its kind's default, and a kind with none is refused", () => {
    const document = (entry: Record<string, unknown>) => ({
      version: 1,
      connections: { c: entry },
    });
    const auth = { kind: "api_key", stored: true };
    const expected = "https://api.anthropic.com";
    for (const open of [{}, { endpoint: "" }, { endpoint: "  " }]) {
      const entries = parseSettingsDocument(
        document({ kind: "anthropic", auth, ...open }),
      );
      expect(entries.connections.c).toMatchObject({ endpoint: expected });
      // The resolved value is concrete, so an export reads back unchanged.
      expect(
        parseSettingsDocument(settingsDocumentOf(entries)).connections,
      ).toEqual(entries.connections);
    }
    expect(
      parseSettingsDocument(
        document({ kind: "anthropic", auth, endpoint: "http://proxy:4000" }),
      ).connections.c,
    ).toMatchObject({ endpoint: "http://proxy:4000" });
    expect(() =>
      parseSettingsDocument(
        document({ kind: "litellm", auth: { kind: "bearer", stored: true } }),
      ),
    ).toThrow(
      "connections.c.endpoint: a litellm connection needs an endpoint, it has no default address",
    );
    expect(() =>
      parseSettingsDocument(
        document({ kind: "anthropic", auth, billing: "none" }),
      ),
    ).toThrow(SettingsDocumentError);
  });

  test("an openai_responses entry takes OpenAI's address, an api_key and no bearer", () => {
    const entry = (auth: Record<string, unknown>) => ({
      version: 1,
      connections: { c: { kind: "openai_responses", auth } },
    });
    const entries = parseSettingsDocument(
      entry({ kind: "api_key", stored: true }),
    );
    expect(entries.connections.c).toMatchObject({
      kind: "openai_responses",
      endpoint: "https://api.openai.com",
    });
    expect(
      parseSettingsDocument(settingsDocumentOf(entries)).connections,
    ).toEqual(entries.connections);
    expect(() =>
      parseSettingsDocument(entry({ kind: "bearer", stored: true })),
    ).toThrow(SettingsDocumentError);
  });

  test("an export without a stored value's last4 still holds no value", () => {
    const text = JSON.stringify(
      settingsDocumentOf(parseSettingsDocument(DOCUMENT)),
    );
    expect(text).not.toContain("connection:console");
    expect(text).toContain('"stored":true');
  });
});

describe("planSettingsImport", () => {
  const entries = parseSettingsDocument(DOCUMENT);

  test("adds every entry over an empty installation", () => {
    const plan = planSettingsImport(entries, NONE);
    expect(plan.add.map((add) => `${add.kind}:${add.id}`)).toEqual([
      "connection:console",
      "connection:main",
      "repository:app",
      "repository:open",
    ]);
    expect(plan.needs_value).toEqual(["connection:console", "connection:main"]);
    expect(plan.conflicts).toEqual([]);
  });

  test("an id already held: same content unchanged, other content a conflict, an inactive row stays so", () => {
    const existing: ExistingSettings = {
      ...NONE,
      connections: new Map([
        [
          "main",
          { entry: entries.connections.main, active: true, has_value: false },
        ],
        [
          "console",
          { entry: entries.connections.console, active: true, has_value: true },
        ],
      ]),
      repositories: new Map([
        [
          "open",
          {
            entry: { ...entries.repositories.open, branch: "trunk" },
            active: true,
            has_value: false,
          },
        ],
        [
          "app",
          { entry: entries.repositories.app, active: false, has_value: false },
        ],
      ]),
    };
    const plan = planSettingsImport(entries, existing);
    expect(plan.unchanged).toEqual(["connection:console", "connection:main"]);
    expect(plan.inactive).toEqual(["repository:app"]);
    expect(plan.conflicts).toEqual(["repository:open"]);
    expect(plan.needs_value).toEqual(["connection:main"]);
    expect(plan.add).toEqual([]);
  });

  describe("a repository the console moved to another branch", () => {
    const app = (branch: string) => ({
      url: "https://github.com/acme/app",
      branch,
      auth: { kind: "github_app" as const },
    });
    const incoming = { connections: {} };
    const row = (entry: unknown) => ({
      ...NONE,
      repositories: new Map([
        ["app", { entry, active: true, has_value: false }],
      ]),
    });

    test("is a conflict, and nothing is added", () => {
      const plan = planSettingsImport(
        { ...incoming, repositories: { app: app("main") } },
        row(app("develop")),
      );
      expect(plan.conflicts).toEqual(["repository:app"]);
      expect(plan.add).toEqual([]);
      expect(plan).not.toHaveProperty("kept");
    });

    test("a legacy row of another auth kind is a conflict, never replaced", () => {
      for (const auth of [
        undefined,
        { kind: "bearer", stored: "repository:app" },
      ]) {
        const plan = planSettingsImport(
          { ...incoming, repositories: { app: app("main") } },
          row({ ...app("develop"), auth }),
        );
        expect(plan.conflicts).toEqual(["repository:app"]);
        expect(plan.add).toEqual([]);
      }
    });
  });

  test("a GitHub repository another id holds, or a value left on a new stored id, is a conflict", () => {
    const existing: ExistingSettings = {
      ...NONE,
      repositories: new Map([
        [
          "acme-app",
          {
            entry: {
              url: "https://github.com/ACME/App",
              branch: "main",
              auth: { kind: "github_app" },
            },
            active: true,
            has_value: false,
          },
        ],
      ]),
      stored_values: new Set(["connection:console"]),
    };
    const plan = planSettingsImport(entries, existing);
    expect(plan.conflicts).toEqual(["connection:console", "repository:app"]);
    const twice = planSettingsImport(
      {
        ...entries,
        repositories: {
          one: {
            url: "https://github.com/acme/app",
            branch: "main",
            auth: { kind: "github_app" },
          },
          two: {
            url: "https://github.com/Acme/App.git",
            branch: "main",
            auth: { kind: "github_app" },
          },
        },
      },
      NONE,
    );
    expect(twice.conflicts).toEqual(["repository:two"]);
  });
});

test("repositoryNameOf reads an App repository's owner and name from its URL", () => {
  expect(
    repositoryNameOf({
      url: "https://github.com/acme/app.git",
      branch: "main",
      auth: { kind: "github_app" },
    }),
  ).toEqual({ owner: "acme", name: "app" });
});

describe("a connection's models in the document", () => {
  const withModels = {
    ...DOCUMENT,
    connections: {
      ...DOCUMENT.connections,
      main: {
        ...DOCUMENT.connections.main,
        models: ["claude-sonnet-5", "claude-opus-5"],
        model_families: {
          "claude-sonnet-5": { family: "sonnet", rank: 5 },
        },
      },
    },
  };

  test("are kept beside the definition, not in it", () => {
    const entries = parseSettingsDocument(withModels);
    expect(entries.connections.main).not.toHaveProperty("models");
    expect(entries.connection_models?.main).toEqual({
      models: ["claude-sonnet-5", "claude-opus-5"],
      model_families: { "claude-sonnet-5": { family: "sonnet", rank: 5 } },
    });
  });

  test("survive an export and a re-import", () => {
    const entries = parseSettingsDocument(withModels);
    const again = parseSettingsDocument(settingsDocumentOf(entries));
    expect(again.connection_models?.main).toEqual(
      entries.connection_models?.main,
    );
    expect(
      (settingsDocumentOf(entries).connections.main as { models: string[] })
        .models,
    ).toEqual(["claude-sonnet-5", "claude-opus-5"]);
  });

  test("a model listed twice refuses the document", () => {
    expect(() =>
      parseSettingsDocument({
        ...DOCUMENT,
        connections: {
          ...DOCUMENT.connections,
          main: { ...DOCUMENT.connections.main, models: ["a", "a"] },
        },
      }),
    ).toThrow("must not repeat a model");
  });
});
