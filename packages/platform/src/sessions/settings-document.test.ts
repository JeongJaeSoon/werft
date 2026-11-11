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
      auth: { kind: "api_key", value_env: "ANTHROPIC_API_KEY" },
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
  mcp_servers: {
    docs: {
      url: "https://mcp.example.invalid/docs",
      credential_ref: "docs_token",
      auth: { kind: "bearer", value_env: "MCP_TOKEN" },
      workspaces: ["acme"],
    },
  },
};

const NONE: ExistingSettings = {
  connections: new Map(),
  repositories: new Map(),
  mcp_servers: new Map(),
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
      value_env: "ANTHROPIC_API_KEY",
    });
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
        mcp_servers: { github: DOCUMENT.mcp_servers.docs },
      },
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
        { kind: "basic", username: "bot", value_env: "GIT_PASSWORD" },
        { kind: "bearer", value_env: "GIT_TOKEN" },
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
      {
        ...DOCUMENT,
        connections: {
          both: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            auth: { kind: "api_key", value_env: "A", stored: true },
          },
        },
      },
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
    const auth = { kind: "api_key", value_env: "ANTHROPIC_API_KEY" };
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
        document({ kind: "litellm", auth: { kind: "bearer", value_env: "K" } }),
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
      entry({ kind: "api_key", value_env: "OPENAI_API_KEY" }),
    );
    expect(entries.connections.c).toMatchObject({
      kind: "openai_responses",
      endpoint: "https://api.openai.com",
    });
    expect(
      parseSettingsDocument(settingsDocumentOf(entries)).connections,
    ).toEqual(entries.connections);
    expect(() =>
      parseSettingsDocument(entry({ kind: "bearer", value_env: "K" })),
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

  test("a connection the console moved to a stored value is kept, not a conflict", () => {
    const moved = {
      ...entries.connections.main,
      auth: { kind: "api_key", stored: "connection:main" },
    };
    const plan = planSettingsImport(
      entries,
      {
        ...NONE,
        connections: new Map([
          [
            "main",
            {
              entry: moved,
              active: true,
              has_value: true,
              replaces: entries.connections.main,
            },
          ],
        ]),
      },
      { allowExternal: true },
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.kept).toEqual(["connection:main"]);
    expect(plan.add.map((add) => add.id)).not.toContain("main");
  });

  test("a document naming the connection otherwise is still a conflict", () => {
    const moved = {
      ...entries.connections.main,
      auth: { kind: "api_key", stored: "connection:main" },
    };
    const other = parseSettingsDocument({
      ...DOCUMENT,
      connections: {
        main: {
          ...DOCUMENT.connections.main,
          auth: { kind: "api_key", value_env: "ANOTHER_KEY" },
        },
      },
    });
    const plan = planSettingsImport(
      other,
      {
        ...NONE,
        connections: new Map([
          [
            "main",
            {
              entry: moved,
              active: true,
              has_value: true,
              replaces: entries.connections.main,
            },
          ],
        ]),
      },
      { allowExternal: true },
    );
    expect(plan.conflicts).toEqual(["connection:main"]);
  });

  test("a new connection under a definition another row moved off is a conflict", () => {
    const moved = {
      ...entries.connections.main,
      auth: { kind: "api_key", stored: "connection:main" },
    };
    const renamed = parseSettingsDocument({
      ...DOCUMENT,
      connections: { twin: DOCUMENT.connections.main },
    });
    const plan = planSettingsImport(
      renamed,
      {
        ...NONE,
        connections: new Map([
          [
            "main",
            {
              entry: moved,
              active: true,
              has_value: true,
              replaces: entries.connections.main,
            },
          ],
        ]),
      },
      { allowExternal: true },
    );
    expect(plan.conflicts).toEqual(["connection:twin"]);
    expect(plan.add.map((add) => add.id)).not.toContain("twin");
  });

  test("adds every entry over an empty installation", () => {
    const plan = planSettingsImport(entries, NONE, { allowExternal: true });
    expect(plan.add.map((add) => `${add.kind}:${add.id}`)).toEqual([
      "connection:console",
      "connection:main",
      "repository:app",
      "repository:open",
      "mcp:docs",
    ]);
    expect(plan.needs_value).toEqual(["connection:console"]);
    expect(plan.conflicts).toEqual([]);
  });

  test("refuses new external references when the caller may not bring one", () => {
    const plan = planSettingsImport(entries, NONE, { allowExternal: false });
    expect(plan.refused_external).toEqual(["connection:main", "mcp:docs"]);
    expect(plan.add.map((add) => add.id)).toEqual(["console", "app", "open"]);
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
    const plan = planSettingsImport(entries, existing, {
      allowExternal: false,
    });
    expect(plan.unchanged).toEqual(["connection:console", "connection:main"]);
    expect(plan.inactive).toEqual(["repository:app"]);
    expect(plan.conflicts).toEqual(["repository:open"]);
    expect(plan.refused_external).toEqual(["mcp:docs"]);
    expect(plan.needs_value).toEqual([]);
    expect(plan.add).toEqual([]);
  });

  describe("a repository the console moved to another branch", () => {
    const app = (branch: string) => ({
      url: "https://github.com/acme/app",
      branch,
      auth: { kind: "github_app" as const },
    });
    const incoming = { connections: {}, mcp_servers: {} };
    const row = (entry: unknown) => ({
      ...NONE,
      repositories: new Map([
        ["app", { entry, active: true, has_value: false }],
      ]),
    });

    test("stays as the database has it when an old directory is imported", () => {
      const plan = planSettingsImport(
        { ...incoming, repositories: { app: app("main") } },
        row(app("develop")),
        { allowExternal: true, databaseOwnsRepositories: true },
      );
      expect(plan.conflicts).toEqual([]);
      expect(plan.kept).toEqual(["repository:app"]);
      expect(plan.add).toEqual([]);
    });

    test("an old directory's second name for it is dropped, as the seed dropped it", () => {
      const plan = planSettingsImport(
        { ...incoming, repositories: { alias: app("main") } },
        row(app("main")),
        { allowExternal: true, databaseOwnsRepositories: true },
      );
      expect(plan.conflicts).toEqual([]);
      expect(plan.kept).toEqual(["repository:alias"]);
      expect(plan.add).toEqual([]);
    });

    test("is still a conflict from a settings document", () => {
      const plan = planSettingsImport(
        { ...incoming, repositories: { app: app("main") } },
        row(app("develop")),
        { allowExternal: true },
      );
      expect(plan.conflicts).toEqual(["repository:app"]);
      expect(plan.kept).toBeUndefined();
    });

    test("a legacy row of another auth kind is still a conflict, never replaced", () => {
      for (const auth of [
        undefined,
        { kind: "bearer", value_env: "GIT_TOKEN" },
      ]) {
        const plan = planSettingsImport(
          { ...incoming, repositories: { app: app("main") } },
          row({ ...app("develop"), auth }),
          { allowExternal: true, databaseOwnsRepositories: true },
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
    const plan = planSettingsImport(entries, existing, { allowExternal: true });
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
      { allowExternal: true },
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
