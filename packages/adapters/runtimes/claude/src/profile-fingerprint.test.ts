import { describe, expect, test } from "bun:test";
import { UnidentifiedComponentError } from "./component-identity.ts";
import type { ClaudeRuntimeConfig } from "./config.ts";
import {
  CLAUDE_PROFILE_DIGEST_SCHEME,
  CLAUDE_RESTORABLE_SCHEMES,
  claudeProfileFingerprint,
} from "./profile-fingerprint.ts";

const config: Pick<
  ClaudeRuntimeConfig,
  | "appendSystemPrompt"
  | "identities"
  | "mcpServers"
  | "model"
  | "permissionMode"
  | "plugins"
  | "profile"
  | "repositoryClaudeMd"
  | "settingSources"
  | "tools"
> = {
  model: "claude-sonnet-4-5",
  profile: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.test",
    auth: { kind: "api_key", value: "secret-one" },
    principal: { ownerScope: "owner-a" },
  },
  tools: ["Bash", "Read"],
};

describe("Claude profile fingerprint", () => {
  test("ignores a rotated credential", () => {
    const rotated = {
      ...config,
      profile: {
        ...config.profile,
        auth: { kind: "api_key" as const, value: "secret-two" },
        principal: { ownerScope: "owner-a" },
      },
    };

    expect(claudeProfileFingerprint(rotated)).toBe(
      claudeProfileFingerprint(config),
    );
  });

  test("ignores the order tools were listed in", () => {
    expect(
      claudeProfileFingerprint({ ...config, tools: ["Read", "Bash"] }),
    ).toBe(claudeProfileFingerprint(config));
  });

  test("changes when the endpoint changes", () => {
    expect(
      claudeProfileFingerprint({
        ...config,
        profile: { ...config.profile, endpoint: "https://other.test" },
      }),
    ).not.toBe(claudeProfileFingerprint(config));
  });

  test("changes when the tool allowlist changes", () => {
    expect(claudeProfileFingerprint({ ...config, tools: ["Bash"] })).not.toBe(
      claudeProfileFingerprint(config),
    );
  });

  test("changes when an MCP server is repointed under the same name", () => {
    const before = {
      ...config,
      mcpServers: { review: { command: "review-server", args: ["--safe"] } },
    };
    const after = {
      ...config,
      mcpServers: { review: { command: "review-server", args: ["--all"] } },
    };

    expect(claudeProfileFingerprint(after)).not.toBe(
      claudeProfileFingerprint(before),
    );
  });

  test("ignores the order MCP servers were declared in", () => {
    const one = {
      ...config,
      mcpServers: { a: { command: "a" }, b: { command: "b" } },
    };
    const other = {
      ...config,
      mcpServers: { b: { command: "b" }, a: { command: "a" } },
    };

    expect(claudeProfileFingerprint(other)).toBe(claudeProfileFingerprint(one));
  });

  test("changes when a plugin is added", () => {
    expect(
      claudeProfileFingerprint({
        ...config,
        identities: { plugins: { "/plugins/review": "review@1.0.0" } },
        plugins: [{ path: "/plugins/review", type: "local" }],
      }),
    ).not.toBe(claudeProfileFingerprint(config));
  });

  test("changes when a plugin at the same path declares a new identity", () => {
    // The path is all the SDK sees, and the same path can hold different
    // code tomorrow; the declared identity is what stands in for its contents.
    const plugins = [{ path: "/plugins/review", type: "local" as const }];
    const v1 = {
      ...config,
      identities: { plugins: { "/plugins/review": "review@1.0.0" } },
      plugins,
    };
    const v2 = {
      ...config,
      identities: { plugins: { "/plugins/review": "review@1.1.0" } },
      plugins,
    };

    expect(claudeProfileFingerprint(v2)).not.toBe(claudeProfileFingerprint(v1));
  });

  test("refuses a plugin with no declared identity", () => {
    const unnamed = {
      ...config,
      plugins: [{ path: "/plugins/review", type: "local" as const }],
    };

    expect(() => claudeProfileFingerprint(unnamed)).toThrow(
      UnidentifiedComponentError,
    );
    expect(() => claudeProfileFingerprint(unnamed)).toThrow(
      /Plugin "\/plugins\/review" has no identity/,
    );
  });

  test("changes when the principal changes on the same endpoint", () => {
    // Two tenants on one shared LiteLLM endpoint differ only in credential,
    // which the digest ignores on purpose; the principal is what tells them
    // apart so one cannot resume the other's checkpoint.
    const tenantA = {
      ...config,
      profile: {
        kind: "litellm" as const,
        endpoint: "https://litellm.test",
        auth: { kind: "bearer" as const, value: "token-a" },
        principal: { ownerScope: "owner-a" },
      },
    };
    const tenantB = {
      ...tenantA,
      profile: {
        ...tenantA.profile,
        auth: { kind: "bearer" as const, value: "token-b" },
        principal: { ownerScope: "owner-b" },
      },
    };
    const tenantARotated = {
      ...tenantA,
      profile: {
        ...tenantA.profile,
        auth: { kind: "bearer" as const, value: "token-a-rotated" },
      },
    };

    expect(claudeProfileFingerprint(tenantB)).not.toBe(
      claudeProfileFingerprint(tenantA),
    );
    expect(claudeProfileFingerprint(tenantARotated)).toBe(
      claudeProfileFingerprint(tenantA),
    );
  });

  test("ignores a rotated MCP header value but not a new header", () => {
    const http = (headers: Record<string, string>) => ({
      ...config,
      identities: { mcpServers: { notion: "notion:owner-a" } },
      mcpServers: {
        notion: { type: "http", url: "https://mcp.notion.test", headers },
      },
    });

    expect(
      claudeProfileFingerprint(http({ Authorization: "Bearer new" })),
    ).toBe(claudeProfileFingerprint(http({ Authorization: "Bearer old" })));
    expect(
      claudeProfileFingerprint(
        http({ Authorization: "Bearer old", "X-Workspace": "w1" }),
      ),
    ).not.toBe(claudeProfileFingerprint(http({ Authorization: "Bearer old" })));
  });

  test("ignores a rotated stdio environment value but not a new variable", () => {
    const stdio = (env: Record<string, string>) => ({
      ...config,
      identities: { mcpServers: { github: "github:owner-a" } },
      mcpServers: { github: { command: "github-mcp", env } },
    });

    expect(claudeProfileFingerprint(stdio({ GITHUB_TOKEN: "ghp_new" }))).toBe(
      claudeProfileFingerprint(stdio({ GITHUB_TOKEN: "ghp_old" })),
    );
    expect(
      claudeProfileFingerprint(
        stdio({ GITHUB_TOKEN: "ghp_old", GITHUB_HOST: "ghe.test" }),
      ),
    ).not.toBe(claudeProfileFingerprint(stdio({ GITHUB_TOKEN: "ghp_old" })));
  });

  test("a server whose headers or env carry values needs a declared identity", () => {
    // Key names cannot tell TENANT=a from TENANT=b; the identity is where
    // the caller states what those values mean.
    const stdio = (identity?: string) => ({
      ...config,
      ...(identity === undefined
        ? {}
        : { identities: { mcpServers: { github: identity } } }),
      mcpServers: { github: { command: "github-mcp", env: { TENANT: "a" } } },
    });

    expect(() => claudeProfileFingerprint(stdio())).toThrow(
      /carries headers or env, whose values the fingerprint does not hash/,
    );
    expect(claudeProfileFingerprint(stdio("github:b"))).not.toBe(
      claudeProfileFingerprint(stdio("github:a")),
    );
  });

  test("a serializable server with no credential container needs no identity", () => {
    expect(
      claudeProfileFingerprint({
        ...config,
        mcpServers: { local: { command: "local-mcp", env: {} } },
      }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  test("still changes when a serializable MCP server is repointed", () => {
    const url = (url: string) => ({
      ...config,
      identities: { mcpServers: { notion: "notion:owner-a" } },
      mcpServers: {
        notion: { type: "http", url, headers: { Authorization: "Bearer t" } },
      },
    });

    expect(claudeProfileFingerprint(url("https://mcp.other.test"))).not.toBe(
      claudeProfileFingerprint(url("https://mcp.notion.test")),
    );
  });

  // `createSdkMcpServer` hands back a live object graph with cycles in it;
  // hashing it verbatim throws, which would stop the session checkpointing.
  class McpServer {
    self: unknown;
    constructor(readonly name: string) {
      this.self = this;
    }
  }

  test("hashes an in-process MCP server by its declared identity", () => {
    const inProcess = (identity: string, name = "review") => ({
      ...config,
      identities: { mcpServers: { review: identity } },
      mcpServers: {
        review: { type: "sdk", name, instance: new McpServer("r") },
      },
    });

    expect(claudeProfileFingerprint(inProcess("review@1"))).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(claudeProfileFingerprint(inProcess("review@1"))).toBe(
      claudeProfileFingerprint(inProcess("review@1")),
    );
    expect(claudeProfileFingerprint(inProcess("review@1"))).not.toBe(
      claudeProfileFingerprint(config),
    );
    expect(claudeProfileFingerprint(inProcess("review@2"))).not.toBe(
      claudeProfileFingerprint(inProcess("review@1")),
    );
    // The wrapper's plain fields still count: the SDK-facing name is part
    // of the tool surface even when the instance behind it is not hashable.
    expect(claudeProfileFingerprint(inProcess("review@1", "other"))).not.toBe(
      claudeProfileFingerprint(inProcess("review@1")),
    );
  });

  test("tells two tenants' in-process servers of one class apart by identity", () => {
    // Same class, same registry name, different tenant state inside: the
    // class name alone called these compatible.
    const tenant = (identity: string) => ({
      ...config,
      identities: { mcpServers: { review: identity } },
      mcpServers: { review: new McpServer("review") },
    });

    expect(claudeProfileFingerprint(tenant("review:owner-b"))).not.toBe(
      claudeProfileFingerprint(tenant("review:owner-a")),
    );
  });

  test("refuses an in-process MCP server with no declared identity", () => {
    const unnamed = {
      ...config,
      mcpServers: { review: new McpServer("review") },
    };

    let thrown: unknown;
    try {
      claudeProfileFingerprint(unnamed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnidentifiedComponentError);
    const error = thrown as UnidentifiedComponentError;
    expect(error.reason).toBe("unidentified_component");
    expect(error.component).toBe("mcp_server");
    expect(error.name).toBe("review");
    expect(error.detail).toMatch(/MCP server "review" is not plain data/);
  });

  test("refuses an identity that is not a non-empty string", () => {
    expect(() =>
      claudeProfileFingerprint({
        ...config,
        identities: { mcpServers: { review: "" } },
        mcpServers: { review: new McpServer("review") },
      }),
    ).toThrow(/must be a non-empty string/);
  });

  test("does not find an identity on the prototype chain", () => {
    expect(() =>
      claudeProfileFingerprint({
        ...config,
        identities: { mcpServers: {} },
        mcpServers: { constructor: new McpServer("constructor") },
      }),
    ).toThrow(UnidentifiedComponentError);
  });

  test("a plain-object cycle is opaque, a shared sub-object is not", () => {
    // `describeOpaque` only stopped at class instances; a cyclic
    // plain object still reached JSON.stringify and threw RangeError.
    const cyclic: Record<string, unknown> = { command: "x" };
    cyclic.self = cyclic;
    expect(() =>
      claudeProfileFingerprint({ ...config, mcpServers: { loop: cyclic } }),
    ).toThrow(UnidentifiedComponentError);

    const shared = { retries: 2 };
    expect(
      claudeProfileFingerprint({
        ...config,
        mcpServers: {
          a: { command: "a", shared },
          b: { command: "b", shared },
        },
      }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reduces env and headers beside a live instance to key names too", () => {
    // A rotated value next to an opaque instance must not move the digest;
    // a new key or a new identity must.
    const opaque = (env: Record<string, string>, identity = "review@1") => ({
      ...config,
      identities: { mcpServers: { review: identity } },
      mcpServers: {
        review: {
          type: "sdk",
          name: "review",
          instance: new McpServer("r"),
          env,
        },
      },
    });

    expect(claudeProfileFingerprint(opaque({ TOKEN: "new" }))).toBe(
      claudeProfileFingerprint(opaque({ TOKEN: "old" })),
    );
    expect(
      claudeProfileFingerprint(opaque({ TOKEN: "old", MODE: "rw" })),
    ).not.toBe(claudeProfileFingerprint(opaque({ TOKEN: "old" })));
    expect(
      claudeProfileFingerprint(opaque({ TOKEN: "old" }, "review@2")),
    ).not.toBe(claudeProfileFingerprint(opaque({ TOKEN: "old" })));
  });

  test("keeps a registry named __proto__ in the fingerprint", () => {
    // The SDK still receives it; an accumulator with an ordinary prototype
    // would swallow it and call the two tool surfaces compatible.
    const withProto = {
      ...config,
      mcpServers: Object.fromEntries([["__proto__", { command: "hidden" }]]),
    };

    expect(claudeProfileFingerprint(withProto)).not.toBe(
      claudeProfileFingerprint(config),
    );
  });

  test("treats a function inside an otherwise plain MCP config as opaque", () => {
    const withCallback = {
      ...config,
      mcpServers: { hooks: { command: "x", onStart: () => undefined } },
    };

    expect(() => claudeProfileFingerprint(withCallback)).toThrow(
      UnidentifiedComponentError,
    );
  });

  test("an sdk entry needs an identity even when its instance is hidden", () => {
    // The SDK reads `instance` directly; a non-enumerable or accessor
    // property must not make the wrapper look like plain data here.
    const hidden = { type: "sdk", name: "review" };
    Object.defineProperty(hidden, "instance", {
      enumerable: false,
      value: new McpServer("review"),
    });
    const viaGetter = {
      command: "x",
      get env() {
        return { TOKEN: "t" };
      },
    };

    expect(() =>
      claudeProfileFingerprint({ ...config, mcpServers: { review: hidden } }),
    ).toThrow(UnidentifiedComponentError);
    expect(() =>
      claudeProfileFingerprint({ ...config, mcpServers: { g: viaGetter } }),
    ).toThrow(UnidentifiedComponentError);
  });

  test("reads plugins by index so an overridden iterator cannot hide one", () => {
    const plugins = [{ path: "/plugins/hidden", type: "local" as const }];
    Object.defineProperty(plugins, Symbol.iterator, {
      value: function* () {},
    });

    expect(() => claudeProfileFingerprint({ ...config, plugins })).toThrow(
      /Plugin "\/plugins\/hidden" has no identity/,
    );
  });

  test("changes when the appended system prompt changes", () => {
    expect(
      claudeProfileFingerprint({ ...config, appendSystemPrompt: "extra" }),
    ).not.toBe(claudeProfileFingerprint(config));
  });

  test("changes with the switch that lets the repository's CLAUDE.md in", () => {
    expect(
      claudeProfileFingerprint({
        ...config,
        repositoryClaudeMd: { contents: "rules" },
        settingSources: [],
      }),
    ).not.toBe(claudeProfileFingerprint({ ...config, settingSources: [] }));
    // The text is not what a checkpoint is compatible with.
    expect(
      claudeProfileFingerprint({
        ...config,
        repositoryClaudeMd: { contents: "rules" },
        settingSources: [],
      }),
    ).toBe(
      claudeProfileFingerprint({
        ...config,
        repositoryClaudeMd: { contents: null },
        settingSources: [],
      }),
    );
    // Off is the digest this config had before the switch existed (main at
    // a609d02), so checkpoints taken then still resume.
    expect(claudeProfileFingerprint(config, 1)).toBe(
      "eab5b7b8016c7fd35dcf94b9e9aef27c727964b297789e2eee65d5d8a4631ae3",
    );
  });

  // Digests computed by the legacy localeCompare encoder for the shape
  // the worker stamps checkpoints with (composition.ts claudeRunConfig):
  // checkpoints taken under them must stay compatible. That shape carries no
  // MCP servers or plugins, the only inputs whose names the two orders sort
  // apart (`serverA` and `server_a`, say).
  test("keeps digests stamped by the legacy localeCompare encoder", () => {
    expect(
      claudeProfileFingerprint(
        {
          model: "claude-sonnet-4-5",
          permissionMode: "acceptEdits",
          profile: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.test/",
            auth: {
              kind: "egress_token",
              token: "t",
              transport: "http://proxy:8080",
            },
            principal: { ownerScope: "owner-a" },
          },
          repositoryClaudeMd: { contents: null },
          settingSources: [],
          tools: ["Read", "Bash"],
        },
        1,
      ),
    ).toBe("81196b9a1cf5206c655fb55fccd357a197963438e20429e09011a7ff661f9898");
    expect(
      claudeProfileFingerprint(
        {
          ...config,
          profile: { ...config.profile, auth: { kind: "api_key", value: "x" } },
          tools: ["Bash"],
        },
        1,
      ),
    ).toBe("922926b3a10d21c4a177a3ac988fae6e02c5095ccac209d8e8655e8a493b39de");
  });

  test("treats an explicit default permission mode as the default", () => {
    expect(
      claudeProfileFingerprint({ ...config, permissionMode: "default" }, 1),
    ).toBe(claudeProfileFingerprint(config, 1));
  });
});

describe("Claude profile fingerprint, scheme 2", () => {
  const modes = ["default", "acceptEdits", "dontAsk", "plan", "auto"] as const;

  test("is the scheme an image of this build stamps", () => {
    expect(CLAUDE_PROFILE_DIGEST_SCHEME).toBe(2);
    expect(CLAUDE_RESTORABLE_SCHEMES).toEqual([1, 2]);
  });

  test("leaves the permission mode out, so a policy change keeps a checkpoint resumable", () => {
    const digests = new Set(
      modes.map((permissionMode) =>
        claudeProfileFingerprint({ ...config, permissionMode }, 2),
      ),
    );
    expect(digests.size).toBe(1);
    expect(claudeProfileFingerprint(config)).toBe(
      claudeProfileFingerprint({ ...config, permissionMode: "plan" }),
    );
  });

  test("still moves with what changes how a transcript replays", () => {
    const own = claudeProfileFingerprint(config, 2);
    expect(claudeProfileFingerprint({ ...config, model: "other" }, 2)).not.toBe(
      own,
    );
    expect(
      claudeProfileFingerprint({ ...config, tools: ["Bash"] }, 2),
    ).not.toBe(own);
    expect(
      claudeProfileFingerprint(
        {
          ...config,
          profile: { ...config.profile, principal: { ownerScope: "owner-b" } },
        },
        2,
      ),
    ).not.toBe(own);
    expect(
      claudeProfileFingerprint({ ...config, appendSystemPrompt: "extra" }, 2),
    ).not.toBe(own);
  });

  test("scheme 1 still hashes the permission mode, to the digest checkpoints were stamped with", () => {
    const one = (permissionMode: "default" | "acceptEdits") =>
      claudeProfileFingerprint({ ...config, permissionMode }, 1);
    expect(one("acceptEdits")).not.toBe(one("default"));
    expect(claudeProfileFingerprint(config, 1)).toBe(
      "eab5b7b8016c7fd35dcf94b9e9aef27c727964b297789e2eee65d5d8a4631ae3",
    );
    expect(claudeProfileFingerprint(config, 2)).not.toBe(
      claudeProfileFingerprint(config, 1),
    );
  });

  test("refuses a scheme it has no hashing for", () => {
    expect(() => claudeProfileFingerprint(config, 3)).toThrow(/scheme 3/);
  });
});
