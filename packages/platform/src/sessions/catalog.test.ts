import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  allowedPair,
  allowedRun,
  type CatalogProfile,
  catalogCredentialRefs,
  claimToolLists,
  describeConfigError,
  environmentCredentials,
  fingerprintModel,
  type InstallationProfileEntry,
  isUnmetered,
  mcpBinding,
  mcpUpstreamOf,
  pinnedMcpTools,
  profileFingerprint,
  profileModels,
  profilePinned,
  profilePins,
  profileWithModel,
  providerUpstreamOf,
  repositoryBinding,
  repositoryModeOf,
  repositoryUpstreamOf,
  resolveSessionCatalog,
  runtimeConfigOf,
  runtimeProviderOf,
  sessionCatalogConfigSchema,
  sessionCatalogView,
  sessionProfile,
} from "./catalog.ts";
import { withSeededInstallation } from "./profile-registry.ts";

// What an operator writes: the credential is a reference, never a value.
const configured = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "1",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value_env: "ANTHROPIC_KEY_MAIN" },
  },
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

function config(
  profile: unknown = configured,
  repositories: unknown = { app: repository },
) {
  return { profiles: { p: profile }, repositories };
}

function load(
  input: unknown,
  lookup = environmentCredentials(env),
): ReturnType<typeof resolveSessionCatalog> {
  const parsed = sessionCatalogConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error(describeConfigError(parsed.error));
  return withSeededInstallation(resolveSessionCatalog(parsed.data, lookup));
}

describe("catalog config schema", () => {
  test("resolves the credential reference once, at load, and keeps where it came from", () => {
    const catalog = load(config());
    const expected: CatalogProfile = {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "1",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "default",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key",
          value: "resolved-key",
          ref: { value_env: "ANTHROPIC_KEY_MAIN" },
        },
      },
      project_settings: { claude_md: false },
    };
    expect(catalog.profiles.p).toEqual(expected);
    expect(catalog.repositories.app).toEqual(resolvedRepository);
    // What the worker protocol carries is neither the value nor where it
    // came from: only the upstream and the proxy's token.
    expect(runtimeProviderOf(expected, "wep_t")).toEqual({
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "egress_token", token: "wep_t" },
    });
    // The proxy is the one handed the value, as the header it injects.
    expect(providerUpstreamOf(expected)).toEqual({
      url: "https://api.anthropic.invalid",
      headers: [["x-api-key", "resolved-key"]],
    });
  });

  test("a Secrets Manager reference resolves through the lookup the loader filled", () => {
    const catalog = load(
      config({
        ...configured,
        provider: {
          ...configured.provider,
          auth: { kind: "api_key", secret_id: "agent-platform/anthropic" },
        },
      }),
      (ref) => ("secret_id" in ref ? "from-secrets" : undefined),
    );
    expect(catalog.profiles.p?.provider.auth).toEqual({
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
      expect(() =>
        load(
          config({ ...configured, provider: { ...configured.provider, auth } }),
        ),
      ).toThrow(/profiles\.p\.provider\.auth/);
    }
  });

  test("a missing credential names the profile and the reference, never a value", () => {
    expect(() =>
      load(config(), environmentCredentials({ ANTHROPIC_KEY_MAIN: "" })),
    ).toThrow(
      /^profiles\.p\.provider\.auth\.value_env: ANTHROPIC_KEY_MAIN is not set$/,
    );
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
          config(configured, { app: { ...repository, auth } }),
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
      const catalog = load(config(configured, { app: github }), keyed(pem));
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
      const rotated = load(config(configured, { app: github }), keyed(other))
        .repositories.app;
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
          config(configured, {
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
        config(configured, {
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
          config(configured, {
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
          load(config(configured, { app: github }), keyed(bad));
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toBe(
          "repositories.app.auth.value_env: GITHUB_APP_KEY is not an RSA private key PEM",
        );
      }
      expect(() =>
        load(config(configured, { app: github }), keyed("")),
      ).toThrow(
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
          sessionCatalogConfigSchema.safeParse(config(configured, { app }))
            .success,
        ).toBe(false);
      }
    });

    test("{ kind: github_app } alone uses the App registered in the console, with no key to resolve", () => {
      const registered = { ...github, auth: { kind: "github_app" } };
      const catalog = load(
        config(configured, { app: registered }),
        environmentCredentials(env),
      );
      const app = catalog.repositories.app;
      if (!app) throw new Error("no repository");
      expect(app.auth).toEqual({ kind: "github_app", registered: true });
      expect(
        catalogCredentialRefs(
          sessionCatalogConfigSchema.parse(
            config(configured, { app: registered }),
          ),
        ).some(({ path }) => path.startsWith("repositories.")),
      ).toBe(false);
      expect(() => repositoryUpstreamOf(app)).toThrow(
        /needs an issued credential/,
      );
      // Moving to it from a keyed entry moves the binding once.
      const keyedApp = load(config(configured, { app: github }), keyed(pem))
        .repositories.app;
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
            config(configured, { app: { ...github, auth } }),
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
            config(configured, {
              app: { ...github, url, auth: { kind: "github_app" } },
            }),
          ).success,
        ).toBe(false);
      }
    });

    test("its route sends the credential the forge issued, never the key", () => {
      const app = load(config(configured, { app: github }), keyed(pem))
        .repositories.app;
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

  test("the repository's CLAUDE.md is let in only when the profile says so, and hooks never are", () => {
    expect(
      load(config({ ...configured, project_settings: { claude_md: true } }))
        .profiles.p?.project_settings,
    ).toEqual({ claude_md: true });
    expect(() =>
      load(
        config({
          ...configured,
          project_settings: { claude_md: true, hooks: true },
        }),
      ),
    ).toThrow(/^profiles\.p\.project_settings: /);
  });

  test("a profile the worker could not run is refused at load, not at claim", () => {
    expect(() => load(config({ ...configured, runtime_kind: "gpt" }))).toThrow(
      /^profiles\.p\.runtime_kind: /,
    );
    const { model: _model, ...withoutModel } = configured;
    expect(() => load(config(withoutModel))).toThrow(/profiles\.p\.model: /);
    // anthropic takes an API key only; bearer is a litellm affordance.
    expect(() =>
      load(
        config({
          ...configured,
          provider: {
            ...configured.provider,
            auth: { kind: "bearer", value_env: "ANTHROPIC_KEY_MAIN" },
          },
        }),
      ),
    ).toThrow(/profiles\.p\.provider\.auth\.kind: /);
  });

  test("no profiles is a catalog: the database holds them, and the file only seeds it", () => {
    expect(load({ profiles: {}, repositories: {} }).profiles).toEqual({});
    expect(() => load(config(configured, {}))).toThrow(
      /repositories: at least one repository is required/,
    );
  });

  test("a catalog of profiles that run without a repository needs no repository", () => {
    const catalog = load(config({ ...configured, repository: "none" }, {}));
    expect(catalog.repositories).toEqual({});
    expect(repositoryModeOf(catalog.profiles.p as CatalogProfile)).toBe("none");
  });

  test("a repository's profiles only seed the database: absent is none, empty is refused", () => {
    expect(() =>
      load(config(configured, { app: { ...repository, profiles: [] } })),
    ).toThrow(/repositories\.app\.profiles/);
    const { profiles: _profiles, ...withoutList } = repository;
    const unlisted = load(config(configured, { app: withoutList }));
    expect(unlisted.repositories.app?.profiles).toBeUndefined();
    expect(allowedPair(unlisted, "p", "app")).toBeNull();
    expect(
      load(config(configured, { app: { ...repository, profiles: ["p", "q"] } }))
        .repositories.app?.profiles,
    ).toEqual(["p", "q"]);
  });

  test("a URL carrying a credential is refused; login names without one are not", () => {
    for (const endpoint of [
      "https://user:pw@api.anthropic.invalid",
      "https://token@api.anthropic.invalid",
      "https://api.anthropic.invalid/?key=abc",
    ]) {
      expect(() =>
        load(
          config({
            ...configured,
            provider: { ...configured.provider, endpoint },
          }),
        ),
      ).toThrow(/profiles\.p\.provider\.endpoint: must not carry a credential/);
    }
    for (const url of [
      "https://oauth2:tok@git.example.invalid/team/app.git",
      "https://oauth2@git.example.invalid/team/app.git",
      "http://git.example.invalid/app.git?private_token=x",
    ]) {
      expect(() =>
        load(config(configured, { app: { ...repository, url } })),
      ).toThrow(/repositories\.app\.url: must not carry a credential/);
    }
    for (const url of [
      "https://git.example.invalid/team/app.git",
      "http://fake-git:3000/agent/sample.git",
    ]) {
      expect(
        sessionCatalogConfigSchema.safeParse(
          config(configured, {
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
});

test("only web addresses: the worker's one way out is the HTTP(S) proxy", () => {
  for (const endpoint of [
    "file:///tmp/messages",
    "ftp://api.anthropic.invalid",
    "not a url",
  ]) {
    expect(() =>
      load(
        config({
          ...configured,
          provider: { ...configured.provider, endpoint },
        }),
      ),
    ).toThrow(/profiles\.p\.provider\.endpoint: must be an http/);
  }
  for (const url of [
    "not a repository",
    "file:///etc/passwd",
    "/srv/git/app.git",
    "ssh://git@git.example.invalid/team/app.git",
    "git://git.example.invalid/app.git",
    "git@git.example.invalid:team/app.git",
    "git.example.invalid:team/app.git",
  ]) {
    expect(
      () => load(config(configured, { app: { ...repository, url } })),
      url,
    ).toThrow(/repositories\.app\.url: must be an http/);
  }
  // The proxy refuses an upstream with a fragment, so the catalog does too.
  expect(() =>
    load(
      config({
        ...configured,
        provider: {
          ...configured.provider,
          endpoint: "https://api.example.invalid/#x",
        },
      }),
    ),
  ).toThrow(/profiles\.p\.provider\.endpoint: must not carry a fragment/);
  for (const endpoint of ["https://10.0.0.5/", "https://[::1]:8443/"]) {
    expect(() =>
      load(
        config({
          ...configured,
          provider: { ...configured.provider, endpoint },
        }),
      ),
    ).toThrow(/profiles\.p\.provider\.endpoint: https must name its host/);
  }
  // Plain http by address stays allowed (a compose service on its IP).
  expect(() =>
    load(
      config({
        ...configured,
        provider: { ...configured.provider, endpoint: "http://10.0.0.5:4000/" },
      }),
    ),
  ).not.toThrow();
});

describe("billing", () => {
  const billed = (billing: string, endpoint: string) =>
    config({
      ...configured,
      provider: { ...configured.provider, endpoint, billing },
    });

  test("none is kept on the profile; per_token, the default, is dropped", () => {
    const none = load(billed("none", "http://litellm:4000")).profiles.p;
    expect(none?.provider.billing).toBe("none");
    expect(isUnmetered(none as CatalogProfile)).toBe(true);
    const perToken = load(billed("per_token", "https://api.anthropic.invalid"))
      .profiles.p;
    expect(perToken?.provider).not.toHaveProperty("billing");
    expect(isUnmetered(perToken as CatalogProfile)).toBe(false);
    expect(perToken).toEqual(load(config()).profiles.p);
  });

  test("none is accepted only on an endpoint public DNS does not serve", () => {
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
      expect(() => load(billed("none", endpoint))).not.toThrow();
    }
    for (const endpoint of [
      "https://api.anthropic.com",
      "https://litellm.example.com",
      "http://8.8.8.8:4000",
      "http://172.32.0.1:4000",
      "http://[2001:db8::1]:4000",
      "http://[fc::1]:4000",
    ]) {
      expect(() => load(billed("none", endpoint))).toThrow(
        /profiles\.p\.provider\.billing: billing none needs an endpoint on a private address/,
      );
    }
  });

  test("an unknown value is refused", () => {
    expect(() => load(billed("free", "http://litellm:4000"))).toThrow(
      /profiles\.p\.provider\.billing/,
    );
  });
});

describe("repository mode", () => {
  const withMode = (repository: string, extra: object = {}) => ({
    ...configured,
    ...extra,
    repository,
  });

  test("omitted or written out, required is the same profile; the others are kept", () => {
    const omitted = load(config()).profiles.p as CatalogProfile;
    expect(omitted).not.toHaveProperty("repository");
    expect(repositoryModeOf(omitted)).toBe("required");
    expect(load(config(withMode("required"))).profiles.p).toEqual(omitted);
    const optional = load(config(withMode("optional"))).profiles
      .p as CatalogProfile;
    expect(repositoryModeOf(optional)).toBe("optional");
    expect(profileFingerprint(optional)).toBe(profileFingerprint(omitted));
    expect(() => load(config(withMode("sometimes")))).toThrow(
      /^profiles\.p\.repository: /,
    );
  });

  test("a none profile cannot let a repository CLAUDE.md in; optional can", () => {
    const claudeMd = { project_settings: { claude_md: true } };
    expect(() =>
      load({
        profiles: { p: configured, q: withMode("none", claudeMd) },
        repositories: { app: repository },
      }),
    ).toThrow(
      /^profiles\.q\.project_settings\.claude_md: a profile with repository none has no repository CLAUDE\.md to read$/,
    );
    expect(
      load(config(withMode("optional", claudeMd))).profiles.p?.project_settings,
    ).toEqual({ claude_md: true });
  });

  test("a none profile is listed by no repository, so no pair allows it", () => {
    const catalog = load({
      profiles: { p: configured, q: withMode("none") },
      repositories: { app: repository },
    });
    expect(repositoryModeOf(catalog.profiles.q as CatalogProfile)).toBe("none");
    expect(allowedPair(catalog, "q", "app")).toBeNull();
    expect(() =>
      load({
        profiles: { p: configured, q: withMode("none") },
        repositories: { app: { ...repository, profiles: ["p", "q"] } },
      }),
    ).toThrow(
      /^repositories\.app\.profiles\.1: names profile q, whose repository is none$/,
    );
  });
});

describe("the catalog view (94S-791)", () => {
  test("holds where each credential comes from, never a value, and pins the same profiles", () => {
    const parsed = sessionCatalogConfigSchema.parse(config());
    const asked: string[] = [];
    const view = sessionCatalogView(parsed);
    expect(asked).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("resolved-key");
    expect(view.profiles.p?.provider.auth).toEqual({
      kind: "api_key",
      ref: { value_env: "ANTHROPIC_KEY_MAIN" },
    });
    expect(view.repositories.app).not.toHaveProperty("auth");
    const resolved = resolveSessionCatalog(parsed, (ref) => {
      asked.push(JSON.stringify(ref));
      return "resolved-key";
    });
    expect(asked).not.toEqual([]);
    const [viewed, full] = [view.profiles.p, resolved.profiles.p];
    if (!viewed || !full) throw new Error("profile p is missing");
    expect(profileFingerprint(viewed)).toBe(profileFingerprint(full));
  });
});

describe("profile fingerprint", () => {
  const base = () => load(config()).profiles.p as CatalogProfile;

  test("a profile without billing, or with per_token, keeps the fingerprint it had before the field", () => {
    const perToken = load(
      config({
        ...configured,
        provider: { ...configured.provider, billing: "per_token" },
      }),
    ).profiles.p as CatalogProfile;
    expect(profileFingerprint(perToken)).toBe(profileFingerprint(base()));
    // The version 1 fingerprint main computed before `billing` existed
    // still names both.
    const before =
      "sha256:99f5f59a41e3bc02be1f2ffd7af4b0a4fae68ca567dc05368cab9285f5ffd983";
    expect(profilePinned(base(), before, [])).toBe(true);
    expect(profilePinned(perToken, before, [])).toBe(true);
    // Declaring none is a new profile.
    const local = (billing?: string) =>
      profileFingerprint(
        load(
          config({
            ...configured,
            provider: {
              ...configured.provider,
              endpoint: "http://litellm:4000",
              ...(billing === undefined ? {} : { billing }),
            },
          }),
        ).profiles.p as CatalogProfile,
      );
    expect(local("none")).not.toBe(local());
  });

  test("is a sha256 over the settings and the reference, never the value", () => {
    const profile = base();
    const fingerprint = profileFingerprint(profile);
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Rotating the value behind the same reference is not a new profile.
    const rotated = load(
      config(),
      environmentCredentials({ ANTHROPIC_KEY_MAIN: "rotated-key" }),
    ).profiles.p as CatalogProfile;
    expect(profileFingerprint(rotated)).toBe(fingerprint);
    // Any setting, or a different place to find the key, is.
    for (const changed of [
      { ...configured, tools: ["Read", "Edit"] },
      { ...configured, project_settings: { claude_md: true } },
      {
        ...configured,
        provider: {
          ...configured.provider,
          auth: { kind: "api_key", value_env: "ANTHROPIC_KEY_OTHER" },
        },
      },
    ]) {
      const other = load(
        config(changed),
        environmentCredentials({ ...env, ANTHROPIC_KEY_OTHER: "resolved-key" }),
      ).profiles.p as CatalogProfile;
      expect(profileFingerprint(other)).not.toBe(fingerprint);
    }
  });

  test("does not depend on key order", () => {
    const profile = base();
    const reordered = Object.fromEntries(
      Object.entries(profile).reverse(),
    ) as CatalogProfile;
    expect(profileFingerprint(reordered)).toBe(profileFingerprint(profile));
  });

  test("leaves out the model, the model list and the repository mode", () => {
    const fingerprint = profileFingerprint(base());
    for (const changed of [
      { ...configured, model: "claude-opus-5-5" },
      { ...configured, models: ["claude-opus-5-5"] },
      { ...configured, repository: "optional" },
    ]) {
      expect(
        profileFingerprint(load(config(changed)).profiles.p as CatalogProfile),
      ).toBe(fingerprint);
    }
  });

  test("a repository binding is the value main computed before version 2", () => {
    // Pending pushes and pull requests hold the binding and compare it
    // when they run, so it must not move with the profile fingerprint.
    const catalog = load(
      config({ ...configured, models: ["claude-opus-5-5"] }),
    );
    expect(repositoryBinding("app", catalog.repositories.app as never)).toBe(
      "sha256:7a4b42bbd44080fb8be864feee0526426cede9b6de453ed5537ce4de4123358e",
    );
  });
});

describe("allowedPair", () => {
  test("only a ceiling's repository_ids let it run, whatever the repository lists", () => {
    const seeded = load({
      profiles: { p: configured },
      repositories: { app: repository },
    });
    const moved = {
      ...seeded,
      installation: new Map<string, InstallationProfileEntry>([
        [
          "p",
          { id: "p", origin: "catalog", state: "usable", repository_ids: [] },
        ],
      ]),
    };
    expect(allowedPair(seeded, "p", "app")).not.toBeNull();
    expect(allowedPair(moved, "p", "app")).toBeNull();
  });

  test("only a repository that lists the profile lets it run", () => {
    const catalog = load({
      profiles: { p: configured, q: configured },
      repositories: {
        app: repository,
        other: { ...repository, profiles: ["q"] },
      },
    });
    expect(allowedPair(catalog, "p", "app")?.repository).toEqual(
      resolvedRepository,
    );
    expect(allowedPair(catalog, "p", "other")).toBeNull();
    expect(allowedPair(catalog, "q", "other")).not.toBeNull();
    expect(allowedPair(catalog, "missing", "app")).toBeNull();
    expect(allowedPair(catalog, "p", "missing")).toBeNull();
    // Prototype keys are not entries.
    expect(allowedPair(catalog, "p", "__proto__")).toBeNull();
    expect(allowedPair(catalog, "constructor", "app")).toBeNull();
  });
});

describe("allowedRun", () => {
  const catalog = load({
    profiles: {
      required: configured,
      optional: { ...configured, repository: "optional" },
      none: { ...configured, repository: "none" },
    },
    repositories: {
      app: { ...repository, profiles: ["required", "optional"] },
    },
  });

  test("without a repository, only a profile whose repository is optional or none runs", () => {
    expect(allowedRun(catalog, "required", null)).toBeNull();
    expect(allowedRun(catalog, "optional", null)).toEqual({
      profile: catalog.profiles.optional as CatalogProfile,
      repository: null,
    });
    expect(allowedRun(catalog, "none", null)?.repository).toBeNull();
    expect(allowedRun(catalog, "missing", null)).toBeNull();
    expect(allowedRun(catalog, "constructor", null)).toBeNull();
  });

  test("with a repository, it is the pair the repository allows", () => {
    expect(allowedRun(catalog, "required", "app")?.repository?.url).toBe(
      repository.url,
    );
    expect(allowedRun(catalog, "optional", "app")).not.toBeNull();
    expect(allowedRun(catalog, "none", "app")).toBeNull();
  });
});

describe("runtimeConfigOf", () => {
  test("a session without a repository has no CLAUDE.md, whatever the profile allows", () => {
    const profile = load(
      config({
        ...configured,
        repository: "optional",
        project_settings: { claude_md: true },
      }),
    ).profiles.p as CatalogProfile;
    expect(runtimeConfigOf(profile, "t", true).project_settings).toEqual({
      claude_md: true,
    });
    expect(runtimeConfigOf(profile, "t", false)).not.toHaveProperty(
      "project_settings",
    );
  });
});

describe("claimToolLists", () => {
  const profile = { tools: ["Read", "Grep", "Bash"] };

  test("without effective tools the release list is the snapshot taken within the profile, as before", () => {
    expect(claimToolLists(profile, ["Bash", "Read", "Other"])).toEqual({
      profile: profile.tools,
      release: ["Read", "Bash"],
      runs: "release",
    });
    expect(claimToolLists(profile, ["Read", "Grep", "Bash"])).toEqual({
      profile: profile.tools,
      release: null,
      runs: "profile",
    });
    expect(claimToolLists(profile, null, true, null).runs).toBe("profile");
  });

  test("effective tools are the release list as stored: no intersection with the profile, narrower or not", () => {
    expect(claimToolLists(profile, ["Read"], true, ["Glob", "Read"])).toEqual({
      profile: profile.tools,
      release: ["Glob", "Read"],
      runs: "release",
    });
    // The profile's own list runs once and is not its own restore candidate.
    expect(claimToolLists(profile, null, true, [...profile.tools])).toEqual({
      profile: profile.tools,
      release: null,
      runs: "profile",
    });
    expect(claimToolLists(profile, null, true, []).release).toEqual([]);
    expect(claimToolLists(profile, null, false, ["Read"]).runs).toBe("profile");
  });
});

describe("models a session may name", () => {
  const offering = (models: unknown) =>
    load(config({ ...configured, models })).profiles.p as CatalogProfile;
  const bare = () => load(config()).profiles.p as CatalogProfile;

  test("the list is optional, never empty, and the default always comes first", () => {
    expect(() => offering([])).toThrow("models");
    expect(() => offering([""])).toThrow("models");
    expect(profileModels(bare())).toEqual(["claude-sonnet-5"]);
    expect(
      profileModels(offering(["claude-opus-5-5", "claude-sonnet-5"])),
    ).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
  });

  test("the list is not part of what a session is pinned to", () => {
    const listed = offering(["claude-opus-5-5"]);
    expect(profileFingerprint(listed)).toBe(profileFingerprint(bare()));
    expect(profileWithModel(listed)).toEqual(bare());
  });

  test("a session runs only a model the profile offers, named on its row", () => {
    const listed = offering(["claude-opus-5-5"]);
    const opus = profileWithModel(listed, "claude-opus-5-5");
    expect(opus?.model).toBe("claude-opus-5-5");
    expect(opus && "models" in opus).toBe(false);
    expect(profileWithModel(listed, "claude-fable-5-1")).toBeNull();
    expect(profileWithModel(bare(), "claude-opus-5-5")).toBeNull();
    const fingerprint = profileFingerprint(listed);
    expect(
      sessionProfile(listed, { fingerprint, model: "claude-opus-5-5" }, []),
    ).toEqual(opus);
    // Off the list, the session's model is no longer there to run.
    expect(
      sessionProfile(bare(), { fingerprint, model: "claude-opus-5-5" }, []),
    ).toBeNull();
    expect(sessionProfile(listed, { fingerprint, model: null }, [])).toBeNull();
    // A row from before the pin runs the default.
    expect(
      sessionProfile(listed, { fingerprint: null, model: null }, []),
    ).toEqual(bare());
  });

  test("a version 1 pin still names the model it was taken with, whatever the row says", () => {
    const listed = offering(["claude-opus-5-5"]);
    // What main pinned a session that named the second model to.
    const v1Opus =
      "sha256:c1810e0b388cb79421095745e83356f1a1e03aee8858fbe4ce65d63f3aa90d5f";
    const opus = profileWithModel(listed, "claude-opus-5-5");
    expect(
      sessionProfile(listed, { fingerprint: v1Opus, model: null }, []),
    ).toEqual(opus);
    expect(
      sessionProfile(
        listed,
        { fingerprint: v1Opus, model: "claude-sonnet-5" },
        [],
      ),
    ).toEqual(opus);
    expect(profilePinned(listed, v1Opus, [])).toBe(true);
    expect(
      sessionProfile(bare(), { fingerprint: v1Opus, model: null }, []),
    ).toBeNull();
    expect(profilePinned(bare(), v1Opus, [])).toBe(false);
    expect(
      fingerprintModel(
        load(config({ ...configured, models: ["claude-opus-5-5"] })),
        "p",
        v1Opus,
      ),
    ).toBe("claude-opus-5-5");
  });

  test("the pins a claim offers: version 2 per model with the default first, then each model's version 1", () => {
    const listed = offering(["claude-opus-5-5"]);
    const current = profileFingerprint(listed);
    expect(profilePins(listed, [])).toEqual([
      { fingerprint: current, model: "claude-sonnet-5" },
      { fingerprint: current, model: "claude-opus-5-5" },
      {
        fingerprint:
          "sha256:99f5f59a41e3bc02be1f2ffd7af4b0a4fae68ca567dc05368cab9285f5ffd983",
        model: null,
      },
      {
        fingerprint:
          "sha256:c1810e0b388cb79421095745e83356f1a1e03aee8858fbe4ce65d63f3aa90d5f",
        model: null,
      },
    ]);
  });

  test("the model a fingerprint names, for the backfill", () => {
    const catalog = load(
      config({ ...configured, models: ["claude-opus-5-5"] }),
    );
    const v1Default =
      "sha256:99f5f59a41e3bc02be1f2ffd7af4b0a4fae68ca567dc05368cab9285f5ffd983";
    expect(fingerprintModel(catalog, "p", v1Default)).toBe("claude-sonnet-5");
    expect(
      fingerprintModel(
        catalog,
        "p",
        profileFingerprint(catalog.profiles.p as CatalogProfile),
      ),
    ).toBeNull();
    expect(fingerprintModel(catalog, "gone", v1Default)).toBeNull();
    expect(
      fingerprintModel(catalog, "p", `sha256:${"0".repeat(64)}`),
    ).toBeNull();
  });
});

describe("pins across a worker image upgrade", () => {
  const at = (runtimeVersion: string, overrides: object = {}) =>
    load(
      config({
        ...configured,
        runtime_version: runtimeVersion,
        models: ["claude-opus-5-5"],
        ...overrides,
      }),
    ).profiles.p as CatalogProfile;
  const before = at("1");
  const v2 = profileFingerprint(before);
  const v1Opus = profilePins(before, [])[3]?.fingerprint as string;

  test("a pin taken under an accepted version still names the profile, which runs as written", () => {
    const after = at("2");
    expect(profileFingerprint(after)).not.toBe(v2);
    const accepted = ["2", "1"];
    expect(
      sessionProfile(
        after,
        { fingerprint: v2, model: "claude-opus-5-5" },
        accepted,
      ),
    ).toEqual(profileWithModel(after, "claude-opus-5-5"));
    expect(
      sessionProfile(after, { fingerprint: v1Opus, model: null }, accepted)
        ?.model,
    ).toBe("claude-opus-5-5");
    expect(profilePinned(after, v2, accepted)).toBe(true);
    const pins = profilePins(after, accepted);
    expect(pins.slice(0, 4)).toEqual(profilePins(after, []));
    expect(pins).toContainEqual({ fingerprint: v2, model: "claude-sonnet-5" });
    expect(pins).toContainEqual({ fingerprint: v1Opus, model: null });
    expect(
      fingerprintModel(
        {
          ...load(
            config({
              ...configured,
              runtime_version: "2",
              models: ["claude-opus-5-5"],
            }),
          ),
          runtime_versions: { accepted, current: ["2"] },
        },
        "p",
        v1Opus,
      ),
    ).toBe("claude-opus-5-5");
  });

  test("without that version accepted, or with no images configured, the pin no longer matches", () => {
    const after = at("2");
    for (const accepted of [[], ["2"], ["3"]]) {
      expect(
        sessionProfile(
          after,
          { fingerprint: v2, model: "claude-opus-5-5" },
          accepted,
        ),
      ).toBeNull();
      expect(profilePinned(after, v2, accepted)).toBe(false);
      expect(profilePinned(after, v1Opus, accepted)).toBe(false);
    }
    expect(profilePins(after, ["2"])).toEqual(profilePins(after, []));
  });

  test("only runtime_version is substituted: any other change still unpins", () => {
    for (const changed of [
      { tools: ["Read", "Edit"] },
      { permission_mode: "plan" },
      {
        provider: {
          ...configured.provider,
          endpoint: "https://elsewhere.anthropic.invalid",
        },
      },
    ]) {
      const after = at("2", changed);
      expect(
        sessionProfile(after, { fingerprint: v2, model: "claude-opus-5-5" }, [
          "2",
          "1",
        ]),
      ).toBeNull();
      expect(profilePinned(after, v2, ["2", "1"])).toBe(false);
      expect(profilePinned(after, v1Opus, ["2", "1"])).toBe(false);
      expect(
        profilePins(after, ["2", "1"]).map((pin) => pin.fingerprint),
      ).not.toContain(v2);
    }
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
