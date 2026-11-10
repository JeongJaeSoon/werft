import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  BILLING_NONE_ENDPOINT_MESSAGE,
  billingFitsEndpoint,
  type CatalogProviderConfig,
  catalogConnectionsSchema,
  catalogCredentialRefs,
  connectionModels,
  describeConfigError,
  environmentCredentials,
  mcpBinding,
  mcpUpstreamOf,
  pinnedMcpTools,
  providerUpstreamOf,
  repositoryBinding,
  repositoryUpstreamOf,
  resolveProvider,
  resolveSessionCatalog,
  runtimeKindOfProvider,
  runtimeProviderOf,
  sessionCatalogConfigSchema,
  sessionCatalogView,
} from "./catalog.ts";

// What an operator writes: the credential is a reference, never a value.
const provider = {
  kind: "anthropic",
  endpoint: "https://api.anthropic.invalid",
  auth: { kind: "api_key", value_env: "ANTHROPIC_KEY_MAIN" },
};
const repository = {
  url: "https://github.com/team/app.git",
  branch: "main",
  auth: { kind: "github_app" as const },
};
const resolvedRepository = {
  ...repository,
  auth: { kind: "github_app" as const, registered: true as const },
};
const env = { ANTHROPIC_KEY_MAIN: "resolved-key" };

function config(repositories: unknown = { app: repository }) {
  return { repositories };
}

function load(
  input: unknown,
  lookup = environmentCredentials(env),
): ReturnType<typeof resolveSessionCatalog> {
  const parsed = sessionCatalogConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error(describeConfigError(parsed.error));
  return resolveSessionCatalog(parsed.data, lookup);
}

/** One connection `c` as the settings parse and resolve it. */
function connect(
  entry: unknown,
  lookup = environmentCredentials(env),
): ReturnType<typeof resolveProvider> {
  const parsed = catalogConnectionsSchema.safeParse({ c: entry });
  if (!parsed.success) {
    throw new Error(`connections.${describeConfigError(parsed.error)}`);
  }
  return resolveProvider("c", parsed.data.c as CatalogProviderConfig, lookup);
}

describe("a connection", () => {
  test("resolves the credential reference once, and keeps where it came from", () => {
    const resolved = connect(provider);
    expect(resolved).toEqual({
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: {
        kind: "api_key",
        value: "resolved-key",
        ref: { value_env: "ANTHROPIC_KEY_MAIN" },
      },
    });
    // What the worker protocol carries is neither the value nor where it
    // came from: only the upstream and the proxy's token.
    expect(runtimeProviderOf(resolved, "wep_t")).toEqual({
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "egress_token", token: "wep_t" },
    });
    // The proxy is the one handed the value, as the header it injects.
    expect(providerUpstreamOf(resolved)).toEqual({
      url: "https://api.anthropic.invalid",
      headers: [["x-api-key", "resolved-key"]],
    });
  });

  test("a Secrets Manager reference resolves through the lookup the loader filled", () => {
    expect(
      connect(
        {
          ...provider,
          auth: { kind: "api_key", secret_id: "agent-platform/anthropic" },
        },
        (ref) => ("secret_id" in ref ? "from-secrets" : undefined),
      ).auth,
    ).toEqual({
      kind: "api_key",
      value: "from-secrets",
      ref: { secret_id: "agent-platform/anthropic" },
    });
  });

  test("exactly one reference: both, neither, or an inline value is refused", () => {
    for (const auth of [
      {
        kind: "api_key",
        value_env: "ANTHROPIC_KEY_MAIN",
        secret_id: "agent-platform/anthropic",
      },
      { kind: "api_key" },
      { kind: "api_key", value: "leaked" },
    ]) {
      expect(() => connect({ ...provider, auth })).toThrow(
        /^connections\.c\.auth/,
      );
    }
  });

  test("a missing credential names the connection and the reference, never a value", () => {
    expect(() =>
      connect(provider, environmentCredentials({ ANTHROPIC_KEY_MAIN: "" })),
    ).toThrow(
      /^connections\.c\.auth\.value_env: ANTHROPIC_KEY_MAIN is not set$/,
    );
  });

  test("an endpoint carrying a credential, or not a web address, is refused", () => {
    for (const [endpoint, message] of [
      ["https://user:pw@api.anthropic.invalid", "must not carry a credential"],
      ["https://token@api.anthropic.invalid", "must not carry a credential"],
      ["https://api.anthropic.invalid/?key=abc", "must not carry a credential"],
      ["file:///tmp/messages", "must be an http"],
      ["ftp://api.anthropic.invalid", "must be an http"],
      ["not a url", "must be an http"],
      // The proxy refuses an upstream with a fragment, so the catalog does too.
      ["https://api.example.invalid/#x", "must not carry a fragment"],
      ["https://10.0.0.5/", "https must name its host"],
      ["https://[::1]:8443/", "https must name its host"],
    ] as const) {
      expect(() => connect({ ...provider, endpoint }), endpoint).toThrow(
        new RegExp(`connections\\.c\\.endpoint: ${message}`),
      );
    }
    // Plain http by address stays allowed (a compose service on its IP).
    expect(() =>
      connect({ ...provider, endpoint: "http://10.0.0.5:4000/" }),
    ).not.toThrow();
  });

  test("runs the runtime of its kind: Responses runs codex, the rest claude", () => {
    expect(runtimeKindOfProvider("anthropic")).toBe("claude_agent_sdk");
    expect(runtimeKindOfProvider("litellm")).toBe("claude_agent_sdk");
    expect(runtimeKindOfProvider("openai_responses")).toBe("codex_app_server");
  });

  test("offers each listed model once, in its order", () => {
    expect(connectionModels({ models: ["b", "a", "b"] })).toEqual(["b", "a"]);
    expect(connectionModels({ models: [] })).toEqual([]);
  });
});

describe("billing", () => {
  test("none is kept on the connection; per_token, the default, is dropped", () => {
    expect(
      connect({ ...provider, endpoint: "http://litellm:4000", billing: "none" })
        .billing,
    ).toBe("none");
    const perToken = connect({ ...provider, billing: "per_token" });
    expect(perToken).not.toHaveProperty("billing");
    expect(perToken).toEqual(connect(provider));
  });

  test("none fits only an endpoint public DNS does not serve", () => {
    for (const endpoint of [
      "http://litellm:4000",
      "http://ollama.internal:11434",
      "http://gpu.local:8000",
      "http://localhost:11434",
      "https://gpu-box.lan",
      "http://10.0.0.5:4000",
      "http://172.20.1.2:4000",
      "http://192.168.1.10:11434",
      "http://100.100.1.1:4000",
      "http://127.0.0.1:11434",
      "http://[::1]:11434",
      "http://[fd12:3456::1]:4000",
    ]) {
      expect(billingFitsEndpoint({ billing: "none", endpoint }), endpoint).toBe(
        true,
      );
    }
    for (const endpoint of [
      "https://api.anthropic.com",
      "https://litellm.example.com",
      "http://8.8.8.8:4000",
      "http://172.32.0.1:4000",
      "http://[2001:db8::1]:4000",
      "http://[fc::1]:4000",
    ]) {
      expect(billingFitsEndpoint({ billing: "none", endpoint }), endpoint).toBe(
        false,
      );
    }
    // per_token fits anywhere.
    expect(billingFitsEndpoint({ endpoint: "https://api.anthropic.com" })).toBe(
      true,
    );
    expect(BILLING_NONE_ENDPOINT_MESSAGE).toContain("billing none");
  });

  test("an unknown value is refused", () => {
    expect(() =>
      connect({
        ...provider,
        endpoint: "http://litellm:4000",
        billing: "free",
      }),
    ).toThrow(/connections\.c\.billing/);
  });
});

describe("catalog config schema", () => {
  test("holds repositories and MCP servers only: profiles are gone", () => {
    expect(load(config()).repositories.app).toEqual(resolvedRepository);
    expect(
      sessionCatalogConfigSchema.safeParse({ ...config(), profiles: {} })
        .success,
    ).toBe(false);
    // A repository that still lists profiles is refused too.
    expect(
      sessionCatalogConfigSchema.safeParse(
        config({ app: { ...repository, profiles: ["p"] } }),
      ).success,
    ).toBe(false);
  });

  test("a repository takes only a GitHub App: no auth, none, basic and bearer are refused", () => {
    for (const auth of [
      undefined,
      { kind: "none" },
      { kind: "basic", username: "reader", value_env: "REPO_TOKEN" },
      { kind: "bearer", value_env: "REPO_TOKEN" },
    ]) {
      expect(
        sessionCatalogConfigSchema.safeParse(
          config({ app: { ...repository, auth } }),
        ).success,
      ).toBe(false);
    }
  });

  describe("a GitHub App repository", () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    const appAuth = {
      kind: "github_app",
      app_id: 101,
      installation_id: 202,
      value_env: "GITHUB_APP_KEY",
    };
    const github = {
      ...repository,
      url: "https://github.com/acme/app.git",
      auth: appAuth,
    };
    const keyed = (key: string) =>
      environmentCredentials({ ...env, GITHUB_APP_KEY: key });

    test("resolves the private key once and keeps it out of the binding and revision", () => {
      const catalog = load(config({ app: github }), keyed(pem));
      const app = catalog.repositories.app;
      if (!app) throw new Error("no repository");
      expect(app.auth).toEqual({
        kind: "github_app",
        app_id: 101,
        installation_id: 202,
        api_base: "https://api.github.com",
        value: pem.trim(),
        ref: { value_env: "GITHUB_APP_KEY" },
      });
      const body = pem.split("\n")[1] ?? "";
      expect(body.length).toBeGreaterThan(20);
      expect(repositoryBinding("app", app)).not.toContain(body);
      // A rotated key behind the same reference keeps the binding; another
      // installation, App or API base does not.
      const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs1", format: "pem" })
        .toString();
      const rotated = load(config({ app: github }), keyed(other)).repositories
        .app;
      if (!rotated) throw new Error("no repository");
      expect(repositoryBinding("app", rotated)).toBe(
        repositoryBinding("app", app),
      );
      for (const moved of [
        { installation_id: 203 },
        { app_id: 102 },
        { api_base: "https://ghes.example.invalid/api/v3" },
      ]) {
        const changed = load(
          config({
            app: { ...github, auth: { ...appAuth, ...moved } },
          }),
          keyed(pem),
        ).repositories.app;
        if (!changed) throw new Error("no repository");
        expect(repositoryBinding("app", changed)).not.toBe(
          repositoryBinding("app", app),
        );
      }
    });

    test("takes a key with escaped newlines, a GHES API base, or a Secrets Manager reference", () => {
      const escaped = pem.trim().replaceAll("\n", "\\n");
      const ghes = load(
        config({
          app: {
            ...github,
            url: "https://ghes.example.invalid/acme/app.git",
            auth: {
              kind: "github_app",
              app_id: 101,
              installation_id: 202,
              secret_id: "github-app-key",
              api_base: "https://ghes.example.invalid/api/v3",
            },
          },
        }),
        (ref) =>
          "secret_id" in ref ? escaped : environmentCredentials(env)(ref),
      ).repositories.app?.auth;
      expect(ghes).toMatchObject({
        api_base: "https://ghes.example.invalid/api/v3",
        value: pem.trim(),
        ref: { secret_id: "github-app-key" },
      });
      // A private host (the local stack's fake GitHub) may be plain http.
      expect(
        load(
          config({
            app: {
              ...github,
              url: "http://fake-github:8080/acme/app.git",
              auth: { ...appAuth, api_base: "http://fake-github:8080" },
            },
          }),
          keyed(pem),
        ).repositories.app?.auth,
      ).toMatchObject({ api_base: "http://fake-github:8080" });
    });

    test("a key that cannot sign fails at load without echoing it", () => {
      const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      for (const bad of ["not-a-pem-at-all", ec]) {
        let message = "";
        try {
          load(config({ app: github }), keyed(bad));
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toBe(
          "repositories.app.auth.value_env: GITHUB_APP_KEY is not an RSA private key PEM",
        );
      }
      expect(() => load(config({ app: github }), keyed(""))).toThrow(
        /^repositories\.app\.auth\.value_env: GITHUB_APP_KEY is not set$/,
      );
    });

    test("the schema refuses what would issue a wrong or unscoped token", () => {
      for (const app of [
        { ...github, auth: { ...appAuth, app_id: "101" } },
        { ...github, auth: { ...appAuth, installation_id: 0 } },
        { ...github, auth: { ...appAuth, username: "x-access-token" } },
        { ...github, auth: { ...appAuth, secret_id: "also" } },
        { ...github, auth: { ...appAuth, value_env: undefined } },
        {
          ...github,
          auth: { ...appAuth, api_base: "http://api.github.example.com" },
        },
        // A token is scoped to `<owner>/<name>`; a URL without one has none.
        { ...github, url: "https://github.com/acme" },
        { ...github, url: "https://github.com/acme/app/tree/main" },
      ]) {
        expect(
          sessionCatalogConfigSchema.safeParse(config({ app })).success,
        ).toBe(false);
      }
    });

    test("{ kind: github_app } alone uses the App registered in the console, with no key to resolve", () => {
      const registered = { ...github, auth: { kind: "github_app" } };
      const catalog = load(
        config({ app: registered }),
        environmentCredentials(env),
      );
      const app = catalog.repositories.app;
      if (!app) throw new Error("no repository");
      expect(app.auth).toEqual({ kind: "github_app", registered: true });
      expect(
        catalogCredentialRefs(
          sessionCatalogConfigSchema.parse(config({ app: registered })),
        ).some(({ path }) => path.startsWith("repositories.")),
      ).toBe(false);
      expect(() => repositoryUpstreamOf(app)).toThrow(
        /needs an issued credential/,
      );
      // Moving to it from a keyed entry moves the binding once.
      const keyedApp = load(config({ app: github }), keyed(pem)).repositories
        .app;
      if (!keyedApp) throw new Error("no repository");
      expect(repositoryBinding("app", app)).not.toBe(
        repositoryBinding("app", keyedApp),
      );
      // Half of the keyed form is neither.
      for (const auth of [
        { kind: "github_app", app_id: 101 },
        { kind: "github_app", installation_id: 202 },
        { kind: "github_app", value_env: "GITHUB_APP_KEY" },
        { kind: "github_app", api_base: "https://ghes.example.invalid/api/v3" },
      ]) {
        expect(
          sessionCatalogConfigSchema.safeParse(
            config({ app: { ...github, auth } }),
          ).success,
        ).toBe(false);
      }
      // The console App's token is a github.com token, and only over TLS.
      for (const url of [
        "https://ghes.example.invalid/acme/app.git",
        "http://github.com/acme/app.git",
      ]) {
        expect(
          sessionCatalogConfigSchema.safeParse(
            config({
              app: { ...github, url, auth: { kind: "github_app" } },
            }),
          ).success,
        ).toBe(false);
      }
    });

    test("its route sends the credential the forge issued, never the key", () => {
      const app = load(config({ app: github }), keyed(pem)).repositories.app;
      if (!app) throw new Error("no repository");
      expect(() => repositoryUpstreamOf(app)).toThrow(
        /needs an issued credential/,
      );
      expect(
        repositoryUpstreamOf(app, {
          username: "x-access-token",
          password: "installation-token-fixture",
        }),
      ).toEqual({
        url: github.url,
        headers: [
          [
            "authorization",
            `Basic ${Buffer.from("x-access-token:installation-token-fixture").toString("base64")}`,
          ],
        ],
      });
    });
  });

  test("a repository URL carrying a credential is refused; login names without one are not", () => {
    for (const url of [
      "https://oauth2:tok@git.example.invalid/team/app.git",
      "https://oauth2@git.example.invalid/team/app.git",
      "http://git.example.invalid/app.git?private_token=x",
    ]) {
      expect(() => load(config({ app: { ...repository, url } }))).toThrow(
        /repositories\.app\.url: must not carry a credential/,
      );
    }
    for (const url of [
      "https://git.example.invalid/team/app.git",
      "http://fake-git:3000/agent/sample.git",
    ]) {
      expect(
        sessionCatalogConfigSchema.safeParse(
          config({
            app: {
              ...repository,
              url,
              auth: {
                kind: "github_app",
                app_id: 101,
                installation_id: 202,
                value_env: "GITHUB_APP_KEY",
              },
            },
          }),
        ).success,
      ).toBe(true);
    }
  });

  test("a repository URL must be a web address: the worker's one way out is the HTTP(S) proxy", () => {
    for (const url of [
      "not a repository",
      "file:///etc/passwd",
      "/srv/git/app.git",
      "ssh://git@git.example.invalid/team/app.git",
      "git://git.example.invalid/app.git",
      "git@git.example.invalid:team/app.git",
      "git.example.invalid:team/app.git",
    ]) {
      expect(() => load(config({ app: { ...repository, url } })), url).toThrow(
        /repositories\.app\.url: must be an http/,
      );
    }
  });

  test("a repository binding does not move by accident", () => {
    // Pending pushes and pull requests hold the binding and compare it when
    // they run. A repository no longer carries a profile list, so this is
    // the value without one.
    expect(
      repositoryBinding("app", load(config()).repositories.app as never),
    ).toBe(
      "sha256:6d80a70194ca682992937f948439afd6a7766be7580bcb54d82aa915746ca5f1",
    );
  });
});

describe("the catalog view (94S-791)", () => {
  test("holds no credential value and asks for none", () => {
    const parsed = sessionCatalogConfigSchema.parse(config());
    const view = sessionCatalogView(parsed);
    expect(JSON.stringify(view)).not.toContain("resolved-key");
    expect(view.repositories.app).not.toHaveProperty("auth");
  });

  test("lists each credential reference the config and the connections name", () => {
    const parsed = sessionCatalogConfigSchema.parse({
      ...config(),
      mcp_servers: {
        fake: {
          url: "http://fake-mcp:4020/mcp",
          credential_ref: "mcp/fake",
          auth: { kind: "bearer", value_env: "FAKE_MCP_SA" },
          workspaces: ["default"],
        },
      },
    });
    const connections = {
      main: catalogConnectionsSchema.parse({ main: provider })
        .main as CatalogProviderConfig,
    };
    expect(catalogCredentialRefs(parsed, connections)).toEqual([
      {
        path: "connections.main.auth",
        ref: { value_env: "ANTHROPIC_KEY_MAIN" },
      },
      { path: "mcp_servers.fake.auth", ref: { value_env: "FAKE_MCP_SA" } },
    ]);
  });
});

describe("remote MCP servers", () => {
  const server = {
    url: "http://fake-mcp:4020/mcp",
    credential_ref: "mcp/fake",
    auth: { kind: "bearer", value_env: "FAKE_MCP_SA" },
    workspaces: ["default"],
  };
  const withMcp = (mcp: unknown) => ({ ...config(), mcp_servers: mcp });
  const lookup = environmentCredentials({ ...env, FAKE_MCP_SA: "sa-value" });

  test("resolves the bearer at load, and only the proxy's upstream holds it", () => {
    const catalog = load(withMcp({ fake: server }), lookup);
    const fake = catalog.mcp_servers?.fake;
    expect(fake?.auth).toEqual({
      kind: "bearer",
      value: "sa-value",
      ref: { value_env: "FAKE_MCP_SA" },
    });
    if (fake === undefined) throw new Error("no server");
    expect(mcpUpstreamOf(fake)).toEqual({
      url: "http://fake-mcp:4020/mcp",
      headers: [["authorization", "Bearer sa-value"]],
    });
    expect(load(config())).not.toHaveProperty("mcp_servers");
  });

  test("refuses what the proxy or the card could not name", () => {
    for (const bad of [
      { a__b: server },
      { Fake: server },
      { fake: { ...server, url: "http://fake-mcp:4020/mcp?x=1" } },
      { fake: { ...server, workspaces: [] } },
      { fake: { ...server, workspaces: ["a", "a"] } },
      { fake: { ...server, credential_ref: "Not A Ref" } },
      { fake: { ...server, auth: { kind: "basic", value_env: "X" } } },
      { fake: { ...server, extra: true } },
      // The built-in server's name.
      { github: server },
    ]) {
      expect(sessionCatalogConfigSchema.safeParse(withMcp(bad)).success).toBe(
        false,
      );
    }
  });

  test("the binding moves with the release, server, URL and credential name only", () => {
    const binding = mcpBinding("rel-1", "fake", server);
    expect(binding).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(mcpBinding("rel-1", "fake", { ...server })).toBe(binding);
    for (const moved of [
      mcpBinding("rel-2", "fake", server),
      mcpBinding("rel-1", "other", server),
      mcpBinding("rel-1", "fake", { ...server, url: "http://x.test/mcp" }),
      mcpBinding("rel-1", "fake", { ...server, credential_ref: "mcp/other" }),
    ]) {
      expect(moved).not.toBe(binding);
    }
  });

  test("a session runs the server's allowed tools only", () => {
    expect(
      pinnedMcpTools("fake", {
        mcp__fake__whoami: "allow",
        mcp__fake__other: "ask",
        mcp__fake__gone: "deny",
        mcp__fake__: "allow",
        mcp__fakery__x: "allow",
        Read: "allow",
      }),
    ).toEqual(["mcp__fake__whoami"]);
  });
});
