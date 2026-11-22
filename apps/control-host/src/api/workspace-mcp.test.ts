import { describe, expect, test } from "bun:test";
import {
  listProviderModels,
  ModelDiscoveryError,
  WorkspaceMcpOutboundError,
} from "@werft-ai/platform";
import {
  startFakeAnthropicServer,
  textReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  startFakeResponsesServer,
  textResponse,
} from "@werft-ai/testkit/fake-responses";
import { OidcUnavailableError } from "./oidc/errors.ts";
import type { NetworkPolicy, PinnedRequest } from "./oidc/provider-http.ts";
import {
  workspaceMcpHostsFromEnv,
  workspaceMcpOutbound,
  workspaceMcpRedirectUri,
  workspaceMcpUrlProblem,
} from "./workspace-mcp.ts";

describe("workspaceMcpHostsFromEnv", () => {
  test("neither list set means no workspace server can be registered", () => {
    expect(workspaceMcpHostsFromEnv({})).toBeNull();
    expect(
      workspaceMcpHostsFromEnv({
        EGRESS_CREDENTIAL_ALLOWLIST: " , ",
        EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "",
      }),
    ).toBeNull();
  });

  test("entries are read the way the egress proxy reads them", () => {
    expect(
      workspaceMcpHostsFromEnv({
        EGRESS_CREDENTIAL_ALLOWLIST:
          " MCP.Example.com:443 , tracker.example.com.:0443",
        EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "[FD00::1]:8080,mcp.lan:8080",
      }),
    ).toEqual({
      credential: [
        "mcp.example.com:443",
        "tracker.example.com:443",
        "fd00::1:8080",
        "mcp.lan:8080",
      ],
      private: ["fd00::1:8080", "mcp.lan:8080"],
    });
  });

  test("a host on both lists is held to the public one", () => {
    const hosts = workspaceMcpHostsFromEnv({
      EGRESS_CREDENTIAL_ALLOWLIST: "mcp.lan:8080",
      EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "mcp.lan:8080",
    });
    expect(hosts?.private).toEqual([]);
    expect(
      hosts && workspaceMcpUrlProblem(hosts, "http://mcp.lan:8080/mcp"),
    ).toBe("url_insecure");
  });

  test("the console's credential hosts are the list registration checks", () => {
    const hosts = workspaceMcpHostsFromEnv({
      EGRESS_CREDENTIAL_ALLOWLIST: " API.Anthropic.com:443, ,github.com.:443",
      EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "fake-messages:4010,github.com:443",
    });
    expect(hosts?.credential).toEqual([
      "api.anthropic.com:443",
      "github.com:443",
      "fake-messages:4010",
    ]);
    expect(
      hosts && workspaceMcpUrlProblem(hosts, "https://api.anthropic.com/mcp"),
    ).toBeNull();
  });
});

describe("workspaceMcpUrlProblem", () => {
  const hosts = workspaceMcpHostsFromEnv({
    EGRESS_CREDENTIAL_ALLOWLIST: "mcp.example.com:443",
    EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "mcp.lan:8080",
  });
  const cases: [string, string | null][] = [
    ["https://mcp.example.com/v1/mcp", null],
    ["https://MCP.example.com.:443/v1/mcp", null],
    ["http://mcp.lan:8080/mcp", null],
    ["https://mcp.lan:8080/mcp", null],
    ["http://mcp.example.com/v1/mcp", "url_insecure"],
    ["http://mcp.lan/mcp", "url_insecure"],
    ["ftp://mcp.lan:8080/mcp", "url_insecure"],
    ["https://other.example.com/mcp", "host_not_allowed"],
    ["https://mcp.example.com:8443/mcp", "host_not_allowed"],
  ];
  for (const [url, problem] of cases) {
    test(`${url} is ${problem ?? "allowed"}`, () => {
      expect(workspaceMcpUrlProblem(hosts, url)).toBe(problem);
    });
  }

  test("no list set refuses every URL", () => {
    expect(workspaceMcpUrlProblem(null, "https://mcp.example.com/v1/mcp")).toBe(
      "credential_allowlist_unset",
    );
  });
});

describe("workspaceMcpOutbound", () => {
  const hosts = workspaceMcpHostsFromEnv({
    EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "mcp.lan:8080",
  });

  test("sends under the narrow policy and hands the answer back", async () => {
    const seen: { url: string; init: unknown; policy: NetworkPolicy }[] = [];
    const request: PinnedRequest = async (url, init, policy) => {
      seen.push({ url, init, policy });
      return { status: 200, text: "{}", headers: new Headers({ "x-a": "1" }) };
    };
    const response = await workspaceMcpOutbound(
      hosts,
      request,
    )({
      url: "http://mcp.lan:8080/mcp",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-a")).toBe("1");
    expect(seen).toEqual([
      {
        url: "http://mcp.lan:8080/mcp",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        policy: { plainHttp: "refuse", privateHosts: ["mcp.lan:8080"] },
      },
    ]);
  });

  test("with no list the policy has no private host", async () => {
    let policy = null as NetworkPolicy | null;
    const request: PinnedRequest = async (_url, _init, given) => {
      policy = given;
      return { status: 204, text: "", headers: new Headers() };
    };
    await workspaceMcpOutbound(
      null,
      request,
    )({ url: "https://a.example/", method: "GET" });
    expect(policy).toEqual({ plainHttp: "refuse", privateHosts: [] });
  });

  const failures: [string, unknown, WorkspaceMcpOutboundError["reason"]][] = [
    [
      "a refused address",
      new OidcUnavailableError("address_not_allowed", "no"),
      "address_not_allowed",
    ],
    ["a 5xx", new OidcUnavailableError("answered", "500"), "answered"],
    [
      "a timeout",
      new OidcUnavailableError("unreachable", "timeout"),
      "unreachable",
    ],
    ["anything else", new TypeError("boom"), "unreachable"],
  ];
  for (const [what, thrown, reason] of failures) {
    test(`${what} is ${reason}`, async () => {
      const request: PinnedRequest = async () => {
        throw thrown;
      };
      const caught = await workspaceMcpOutbound(
        hosts,
        request,
      )({
        url: "https://a.example/",
        method: "GET",
      }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(WorkspaceMcpOutboundError);
      expect((caught as WorkspaceMcpOutboundError).reason).toBe(reason);
    });
  }
});

describe("workspaceMcpRedirectUri", () => {
  test("is the server's own callback page, or null with no console origin", () => {
    expect(workspaceMcpRedirectUri("https://console.example.com", "abc")).toBe(
      "https://console.example.com/settings/workspace/mcp-servers/abc/callback",
    );
    expect(workspaceMcpRedirectUri(null, "abc")).toBeNull();
  });
});

describe("a connection's model list over the outbound policy", () => {
  const KEY = "example-model-key";
  const ref = { stored: "connection:fake" } as const;
  const privateTo = (url: string) =>
    workspaceMcpHostsFromEnv({
      EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: new URL(url).host,
    });

  test("reads every page of the fake Anthropic list with the key it was given", async () => {
    const server = startFakeAnthropicServer(textReply("x"), {
      models: Array.from({ length: 3 }, (_, index) => ({
        id: `claude-${index}`,
        display_name: `Claude ${index}`,
      })),
      modelsPageMax: 2,
    });
    try {
      const listed = await listProviderModels(
        {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: KEY, ref },
        },
        workspaceMcpOutbound(privateTo(server.url)),
      );
      expect(listed).toEqual({
        models: [0, 1, 2].map((index) => ({
          id: `claude-${index}`,
          display_name: `Claude ${index}`,
        })),
        skipped: 0,
        truncated: false,
      });
      expect(server.modelRequests.map((request) => request.path)).toEqual([
        "/v1/models?limit=1000",
        "/v1/models?limit=1000&after_id=claude-1",
      ]);
      for (const request of server.modelRequests) {
        expect(request.headers["x-api-key"]).toBe(KEY);
        expect(request.headers["anthropic-version"]).toBe("2023-06-01");
        expect(request.headers.authorization).toBeUndefined();
      }
    } finally {
      server.stop();
    }
  });

  test("reads the fake OpenAI list with a bearer key, leaving out what no agent talks to", async () => {
    const server = startFakeResponsesServer(textResponse("ok"));
    try {
      const listed = await listProviderModels(
        {
          kind: "openai_responses",
          endpoint: `${server.url}/`,
          auth: { kind: "api_key", value: KEY, ref },
        },
        workspaceMcpOutbound(privateTo(server.url)),
      );
      expect(listed).toEqual({
        models: [
          { id: "gpt-5.5", display_name: null },
          { id: "o4-mini", display_name: null },
        ],
        skipped: 4,
        truncated: false,
      });
      expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    } finally {
      server.stop();
    }
  });

  test("a loopback provider off the private list is never called", async () => {
    const server = startFakeResponsesServer(textResponse("ok"));
    try {
      let refused: unknown;
      try {
        await listProviderModels(
          {
            kind: "openai_responses",
            endpoint: server.url,
            auth: { kind: "api_key", value: KEY, ref },
          },
          workspaceMcpOutbound(
            workspaceMcpHostsFromEnv({
              EGRESS_CREDENTIAL_ALLOWLIST: new URL(server.url).host,
            }),
          ),
        );
      } catch (error) {
        refused = error;
      }
      expect(refused instanceof ModelDiscoveryError).toBe(true);
      expect((refused as ModelDiscoveryError).reason).toBe(
        "address_not_allowed",
      );
      expect(server.requests).toHaveLength(0);
    } finally {
      server.stop();
    }
  });
});
