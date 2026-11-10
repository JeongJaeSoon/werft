import { describe, expect, test } from "bun:test";
import type { ClaudeRuntimeConfig } from "./config.ts";
import {
  engineApiKey,
  publicProfile,
  runtimeEnvironment,
  validateRuntimeConfig,
} from "./profile.ts";

const baseConfig: ClaudeRuntimeConfig = {
  claudeConfigDir: "/tenant/config",
  correlationId: "corr-1",
  mode: "new",
  cwd: "/tenant/workspace",
  home: "/tenant/home",
  model: "primary",
  profile: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "api_key", value: "placeholder-direct" },
    principal: { ownerScope: "owner-a" },
  },
  tools: ["Read", "Edit"],
};

const policy = {
  endpoints: ["https://api.anthropic.com"],
  models: ["primary"],
};
const mirror = {
  async append() {},
  async listSubkeys() {
    return [];
  },
  async load() {
    return null;
  },
};

describe("runtime profiles", () => {
  test("refuses to resume against a mirror that is not revision-scoped", () => {
    // The live mirror still holds whatever was written after the checkpoint
    // being resumed; replaying that is a different conversation.
    expect(() =>
      validateRuntimeConfig(
        {
          ...baseConfig,
          mode: "resume",
          resume: "sdk-session-1",
          sessionStore: mirror,
        },
        policy,
      ),
    ).toThrow(/revision-scoped/);
  });

  test("refuses to resume with no mirror at all", () => {
    // The omission is the dangerous case: nothing here says "restore", the
    // engine falls back to the container's own CLAUDE_CONFIG_DIR, and the
    // session silently continues from whatever that disk happens to hold.
    expect(() =>
      validateRuntimeConfig(
        { ...baseConfig, mode: "resume", resume: "sdk-session-1" },
        policy,
      ),
    ).toThrow(/revision-scoped/);
  });

  test("resumes from local disk only when the caller says so", () => {
    const config = {
      ...baseConfig,
      localTranscriptResume: true as const,
      mode: "resume" as const,
      resume: "sdk-session-1",
    };

    expect(validateRuntimeConfig(config, policy)).toBe(config);
  });

  test("resumes against a mirror pinned to the restored revision", () => {
    const config = {
      ...baseConfig,
      mode: "resume" as const,
      resume: "sdk-session-1",
      sessionStore: { ...mirror, revisionScoped: true },
    };

    expect(validateRuntimeConfig(config, policy)).toBe(config);
  });

  test("a fresh run may take the live mirror", () => {
    const config = { ...baseConfig, sessionStore: mirror };

    expect(validateRuntimeConfig(config, policy)).toBe(config);
  });

  test("lets the repository's CLAUDE.md in only with the project source left out", () => {
    const isolated = {
      ...baseConfig,
      repositoryClaudeMd: { contents: "rules" },
      settingSources: [] as [],
    };
    expect(validateRuntimeConfig(isolated, policy)).toBe(isolated);
    expect(() =>
      validateRuntimeConfig(
        { ...baseConfig, repositoryClaudeMd: { contents: null } },
        policy,
      ),
    ).toThrow(/needs settingSources: \[\]/);
    expect(() =>
      validateRuntimeConfig(
        {
          ...baseConfig,
          repositoryClaudeMd: { contents: "rules" },
          settingSources: ["project"],
        },
        policy,
      ),
    ).toThrow(/needs settingSources: \[\]/);
  });

  test("accepts only approved endpoints and model aliases", () => {
    expect(
      validateRuntimeConfig(baseConfig, {
        endpoints: ["https://api.anthropic.com/"],
        models: ["primary"],
      }),
    ).toBe(baseConfig);
    expect(() =>
      validateRuntimeConfig(baseConfig, {
        endpoints: ["https://proxy.example.com"],
        models: ["primary"],
      }),
    ).toThrow("endpoint");
    expect(() =>
      validateRuntimeConfig(baseConfig, {
        endpoints: ["https://api.anthropic.com"],
        models: ["unapproved"],
      }),
    ).toThrow("model");
  });

  test("builds a minimal direct API environment without copying the host", () => {
    const environment = runtimeEnvironment(baseConfig, {
      PATH: "/bin",
      LANG: "C.UTF-8",
      HOST_PRIVATE_VALUE: "must-not-pass",
    });
    expect(environment).toEqual({
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: "/tenant/config",
      HOME: "/tenant/home",
      LANG: "C.UTF-8",
      PATH: "/bin",
      TMPDIR: expect.any(String),
    });
    expect(environment.HOST_PRIVATE_VALUE).toBeUndefined();
  });

  test("the host's OTEL_* keys do not reach the engine", () => {
    const environment = runtimeEnvironment(baseConfig, {
      PATH: "/bin",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=SECRET",
    });
    expect(
      Object.keys(environment).filter((k) => k.startsWith("OTEL_")),
    ).toEqual([]);
  });

  describe("user variables", () => {
    const host = { PATH: "/bin", LANG: "C.UTF-8" };

    test("an ordinary name reaches the engine next to the platform's keys", () => {
      const withUser = runtimeEnvironment(
        {
          ...baseConfig,
          userEnvironment: { REGION: "eu", TEAM_TOKEN_NAME: "x" },
        },
        host,
      );
      expect(withUser).toEqual({
        ...runtimeEnvironment(baseConfig, host),
        REGION: "eu",
        TEAM_TOKEN_NAME: "x",
      });
    });

    test("without variables the environment is what it was", () => {
      expect(
        runtimeEnvironment({ ...baseConfig, userEnvironment: {} }, host),
      ).toEqual(runtimeEnvironment(baseConfig, host));
    });

    // The adapter sets some of these only when its config says so, so a
    // user value would survive for them if the list did not refuse it.
    test.each([
      "PATH",
      "HOME",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_MAX_RETRIES",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "NODE_EXTRA_CA_CERTS",
      "HTTPS_PROXY",
      "NO_PROXY",
      "GIT_AUTHOR_NAME",
    ])(
      "%s is refused before the engine starts, without echoing a value",
      (name) => {
        let message = "";
        try {
          runtimeEnvironment(
            { ...baseConfig, userEnvironment: { [name]: "never-print-this" } },
            host,
          );
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain(name);
        expect(message).not.toContain("never-print-this");
      },
    );

    test("the engine's key descriptor stays 3 whatever the user sends", () => {
      const environment = runtimeEnvironment(
        { ...baseConfig, userEnvironment: { REGION: "eu" } },
        host,
      );
      expect(environment.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR).toBe("3");
    });
  });

  test("forwards the host's egress proxy variables and nothing else", () => {
    // On the worker network the proxy is the only route to the Messages
    // endpoint; the engine only learns it through these.
    const environment = runtimeEnvironment(baseConfig, {
      ALL_PROXY: "socks5://must-not-pass",
      ANTHROPIC_API_KEY: "host-key-must-not-pass",
      ANTHROPIC_BASE_URL: "https://host.example.com",
      HTTP_PROXY: "http://egress-proxy:3128",
      HTTPS_PROXY: "http://egress-proxy:3128",
      NODE_EXTRA_CA_CERTS: "/etc/egress/ca.pem",
      NODE_OPTIONS: "--must-not-pass",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NO_PROXY: "localhost,127.0.0.1,::1",
      PATH: "/bin",
      SSL_CERT_FILE: "/must/not/pass",
      http_proxy: "http://egress-proxy:3128",
      https_proxy: "http://egress-proxy:3128",
      no_proxy: "localhost,127.0.0.1,::1",
    });
    expect(environment).toEqual({
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: "/tenant/config",
      HOME: "/tenant/home",
      HTTP_PROXY: "http://egress-proxy:3128",
      HTTPS_PROXY: "http://egress-proxy:3128",
      LANG: "en_US.UTF-8",
      NO_PROXY: "localhost,127.0.0.1,::1",
      PATH: "/bin",
      TMPDIR: expect.any(String),
      http_proxy: "http://egress-proxy:3128",
      https_proxy: "http://egress-proxy:3128",
      no_proxy: "localhost,127.0.0.1,::1",
    });
  });

  test("trusts an extra CA bundle only when the config names one", () => {
    // The host's bundle would make whoever holds that CA able to impersonate
    // the Messages endpoint; trust is a composition decision, not ambient.
    const host = { NODE_EXTRA_CA_CERTS: "/host/ca.pem", PATH: "/bin" };
    expect("NODE_EXTRA_CA_CERTS" in runtimeEnvironment(baseConfig, host)).toBe(
      false,
    );
    expect(
      runtimeEnvironment(
        { ...baseConfig, trustedCaBundle: "/etc/egress/ca.pem" },
        host,
      ).NODE_EXTRA_CA_CERTS,
    ).toBe("/etc/egress/ca.pem");
  });

  test("forwards each proxy variable only when the host sets it", () => {
    // A lowercase-only host must not grow uppercase twins the engine would
    // then read with a different precedence than the host intended.
    const environment = runtimeEnvironment(baseConfig, {
      PATH: "/bin",
      https_proxy: "http://egress-proxy:3128",
    });
    expect(environment.https_proxy).toBe("http://egress-proxy:3128");
    expect("HTTPS_PROXY" in environment).toBe(false);
    expect("HTTP_PROXY" in environment).toBe(false);
    expect("NO_PROXY" in environment).toBe(false);
  });

  test("uses the profile-specific LiteLLM authentication transport", () => {
    const bearer = runtimeEnvironment({
      ...baseConfig,
      profile: {
        kind: "litellm",
        endpoint: "https://proxy.example.com/v1",
        auth: { kind: "bearer", value: "placeholder-bearer" },
        principal: { ownerScope: "owner-a" },
      },
    });
    expect(bearer.ANTHROPIC_AUTH_TOKEN).toBe("placeholder-bearer");
    expect(bearer.ANTHROPIC_API_KEY).toBeUndefined();
    expect(bearer.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR).toBeUndefined();
    expect(publicProfile(baseConfig.profile)).toEqual({
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth_kind: "api_key",
      principal: { ownerScope: "owner-a" },
    });
  });

  test("an egress token talks to the proxy's route and holds only the token", () => {
    const egress = {
      ...baseConfig,
      profile: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.com",
        auth: {
          kind: "egress_token" as const,
          token: "wep_attempt-token",
          transport: "http://egress-proxy:3129/provider/",
        },
        principal: { ownerScope: "owner-a" },
      },
    };
    // Policy still judges the upstream, not the proxy.
    expect(validateRuntimeConfig(egress, policy)).toBe(egress);
    const environment = runtimeEnvironment(egress, {
      PATH: "/bin",
      HTTPS_PROXY: "http://egress-proxy:3128",
      NO_PROXY: "localhost",
    });
    expect(environment.ANTHROPIC_BASE_URL).toBe(
      "http://egress-proxy:3129/provider",
    );
    // The token goes down the engine's key descriptor, never its environment.
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR).toBe("3");
    expect(engineApiKey(egress.profile)).toBe("wep_attempt-token");
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(environment.NO_PROXY).toBe("localhost,egress-proxy");
    expect("no_proxy" in environment).toBe(false);
    // With no bypass list on the host, both spellings carry the same one.
    const bare = runtimeEnvironment(egress, { PATH: "/bin" });
    expect(bare.NO_PROXY).toBe("egress-proxy");
    expect(bare.no_proxy).toBe("egress-proxy");
    // The token and where the proxy listens stay out of the fingerprint.
    expect(publicProfile(egress.profile)).toEqual({
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth_kind: "egress_token",
      principal: { ownerScope: "owner-a" },
    });
    expect(() =>
      validateRuntimeConfig(
        {
          ...egress,
          profile: {
            ...egress.profile,
            auth: { ...egress.profile.auth, transport: "file:///proxy" },
          },
        },
        policy,
      ),
    ).toThrow(/http or https/);
  });

  test("a profile has to say who it acts for", () => {
    const { principal: _principal, ...anonymous } = baseConfig.profile;

    expect(() =>
      validateRuntimeConfig(
        { ...baseConfig, profile: anonymous as typeof baseConfig.profile },
        policy,
      ),
    ).toThrow(/principal/);
  });

  test("refuses to start a run whose MCP server has no identity", () => {
    // Every checkpoint such a run took would be unverifiable; the refusal
    // belongs before the first turn, with the component named.
    class McpServer {}
    const opaque = { ...baseConfig, mcpServers: { review: new McpServer() } };

    expect(() => validateRuntimeConfig(opaque, policy)).toThrow(
      /MCP server "review" is not plain data and has no identity/,
    );
    expect(
      validateRuntimeConfig(
        { ...opaque, identities: { mcpServers: { review: "review@1" } } },
        policy,
      ),
    ).toEqual({
      ...opaque,
      identities: { mcpServers: { review: "review@1" } },
    });
  });

  test("refuses to resume a run whose plugin has no identity", () => {
    const resume = {
      ...baseConfig,
      localTranscriptResume: true as const,
      mode: "resume" as const,
      plugins: [{ path: "/tenant/plugin", type: "local" as const }],
      resume: "sdk-session-1",
    };

    expect(() => validateRuntimeConfig(resume, policy)).toThrow(
      /Plugin "\/tenant\/plugin" has no identity/,
    );
  });
});
