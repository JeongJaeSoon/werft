import { describe, expect, test } from "bun:test";
import {
  listProviderModels,
  ModelDiscoveryError,
  OutboundRefusedError,
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
import type {
  Lookup,
  NetworkPolicy,
  PinnedRequest,
} from "./oidc/provider-http.ts";
import {
  connectionEndpointProblem,
  connectionModelsOutbound,
  workspaceMcpAddressCheck,
  workspaceMcpHostsFromEnv,
  workspaceMcpListed,
  workspaceMcpOutbound,
  workspaceMcpRedirectUri,
  workspaceMcpServerUrlProblem,
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
      hosts && connectionEndpointProblem(hosts, "http://mcp.lan:8080/mcp"),
    ).toBe("url_insecure");
  });

  test("an entry the egress proxy refuses allows nothing", () => {
    const hosts = workspaceMcpHostsFromEnv({
      EGRESS_CREDENTIAL_ALLOWLIST:
        "[fd00::1:443],mcp.example.com,zero.example.com:0,word.example.com:https,:443",
    });
    expect(hosts).toBeNull();
    const kept = workspaceMcpHostsFromEnv({
      EGRESS_CREDENTIAL_ALLOWLIST: "[fd00::1:443],mcp.example.com:443",
    });
    expect(kept?.credential).toEqual(["mcp.example.com:443"]);
    // Read as a host:port string, [fd00::1:443] would name [fd00::1]:443.
    expect(
      kept && connectionEndpointProblem(kept, "https://[fd00::1]:443/mcp"),
    ).toBe("host_not_allowed");
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
      hosts &&
        connectionEndpointProblem(hosts, "https://api.anthropic.com/mcp"),
    ).toBeNull();
  });
});

describe("connectionEndpointProblem", () => {
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
      expect(connectionEndpointProblem(hosts, url)).toBe(problem);
    });
  }

  test("no list set refuses every URL", () => {
    expect(
      connectionEndpointProblem(null, "https://mcp.example.com/v1/mcp"),
    ).toBe("credential_allowlist_unset");
  });
});

describe("workspaceMcpServerUrlProblem", () => {
  const hosts = workspaceMcpHostsFromEnv({
    EGRESS_CREDENTIAL_ALLOWLIST: "mcp.example.com:443",
    EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "mcp.lan:8080,10.0.0.9:8080",
  });
  const cases: [string, "url_insecure" | "url_invalid" | null][] = [
    // Off both lists: a public https server needs no operator entry.
    ["https://mcp.atlassian.com/v2/mcp", null],
    ["https://MCP.Other.example.:8443/mcp", null],
    ["https://mcp.example.com/v1/mcp", null],
    ["http://mcp.lan:8080/mcp", null],
    ["http://10.0.0.9:8080/mcp", null],
    ["https://mcp.lan:8080/mcp", null],
    ["http://example.com/mcp", "url_insecure"],
    ["http://mcp.lan/mcp", "url_insecure"],
    ["http://mcp.example.com/v1/mcp", "url_insecure"],
    ["ftp://mcp.lan:8080/mcp", "url_insecure"],
    // The proxy dials an https upstream by name only.
    ["https://10.0.0.5/mcp", "url_invalid"],
    ["https://127.0.0.1/mcp", "url_invalid"],
    ["https://169.254.169.254/", "url_invalid"],
    ["https://[::1]/mcp", "url_invalid"],
    ["https://0x7f.1/mcp", "url_invalid"],
    ["https://10.0.0.9:8080/mcp", "url_invalid"],
  ];
  for (const [url, problem] of cases) {
    test(`${url} is ${problem ?? "allowed"}`, () => {
      expect(workspaceMcpServerUrlProblem(hosts, url)).toBe(problem);
    });
  }

  test("with no list set a public https server is still allowed, plain http never", () => {
    expect(
      workspaceMcpServerUrlProblem(null, "https://mcp.atlassian.com/v2/mcp"),
    ).toBeNull();
    expect(workspaceMcpServerUrlProblem(null, "http://mcp.lan:8080/mcp")).toBe(
      "url_insecure",
    );
  });
});

describe("workspaceMcpAddressCheck", () => {
  const hosts = workspaceMcpHostsFromEnv({
    EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "mcp.lan:8080",
  });
  const answering =
    (addresses: string[]): Lookup =>
    async () =>
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));
  const PUBLIC = "93.184.215.14";
  const cases: [
    string,
    string,
    string[],
    "address_not_allowed" | "unreachable" | null,
  ][] = [
    ["a public name", "https://mcp.example.com/mcp", [PUBLIC], null],
    [
      "a public name over IPv6",
      "https://mcp.example.com/mcp",
      ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
      null,
    ],
    [
      "a name that resolves privately",
      "https://mcp.example.com/mcp",
      ["10.0.0.5"],
      "address_not_allowed",
    ],
    [
      "a name with one private answer among public ones",
      "https://mcp.example.com/mcp",
      [PUBLIC, "192.168.1.4"],
      "address_not_allowed",
    ],
    [
      "a loopback name",
      "https://mcp.example.com/mcp",
      ["127.0.0.1"],
      "address_not_allowed",
    ],
    [
      "the metadata address",
      "https://mcp.example.com/mcp",
      ["169.254.169.254"],
      "address_not_allowed",
    ],
    [
      "a private address carried in IPv6",
      "https://mcp.example.com/mcp",
      ["::ffff:10.0.0.5"],
      "address_not_allowed",
    ],
    [
      "a private-list host that resolves privately",
      "http://mcp.lan:8080/mcp",
      ["10.0.0.5"],
      null,
    ],
    [
      "a private-list host that resolves publicly",
      "http://mcp.lan:8080/mcp",
      [PUBLIC],
      "address_not_allowed",
    ],
    [
      "a private-list host's metadata address",
      "http://mcp.lan:8080/mcp",
      ["100.100.100.200"],
      "address_not_allowed",
    ],
    [
      "the private-list host on another port",
      "https://mcp.lan/mcp",
      ["10.0.0.5"],
      "address_not_allowed",
    ],
    [
      "a metadata service name, whatever it answers",
      "https://Metadata.Google.Internal./computeMetadata/v1/",
      [PUBLIC],
      "address_not_allowed",
    ],
    ["a name with no answer", "https://mcp.example.com/mcp", [], "unreachable"],
  ];
  for (const [what, url, addresses, problem] of cases) {
    test(`${what} is ${problem ?? "allowed"}`, async () => {
      expect(
        await workspaceMcpAddressCheck(hosts, answering(addresses))(url),
      ).toBe(problem);
    });
  }

  test("a lookup that fails is unreachable, not allowed", async () => {
    const lookup: Lookup = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(
      await workspaceMcpAddressCheck(hosts, lookup)("https://mcp.example.com/"),
    ).toBe("unreachable");
  });
});

describe("workspaceMcpListed", () => {
  const hosts = workspaceMcpHostsFromEnv({
    EGRESS_CREDENTIAL_ALLOWLIST: "mcp.example.com:443,both.lan:8080",
    EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "mcp.lan:8080,both.lan:8080",
  });
  const cases: [string, "public" | "private" | null][] = [
    ["https://MCP.example.com.:443/v1/mcp", "public"],
    ["http://mcp.lan:8080/mcp", "private"],
    // A host on both lists is held to the public one, as the proxy holds it.
    ["https://both.lan:8080/mcp", "public"],
    ["https://mcp.example.com:8443/mcp", null],
    ["https://mcp.atlassian.com/v2/mcp", null],
  ];
  for (const [url, listed] of cases) {
    test(`${url} is ${listed ?? "on neither"}`, () => {
      expect(workspaceMcpListed(hosts, url)).toBe(listed);
    });
  }

  test("with no list set every host is on neither", () => {
    expect(workspaceMcpListed(null, "https://mcp.example.com/")).toBeNull();
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
        policy: {
          plainHttp: "refuse",
          privateHosts: ["mcp.lan:8080"],
          privateHostsStayPrivate: true,
        },
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
    expect(policy).toEqual({
      plainHttp: "refuse",
      privateHosts: [],
      privateHostsStayPrivate: true,
    });
  });

  const failures: [string, unknown, OutboundRefusedError["reason"]][] = [
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
      expect(caught).toBeInstanceOf(OutboundRefusedError);
      expect((caught as OutboundRefusedError).reason).toBe(reason);
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
        connectionModelsOutbound(privateTo(server.url)),
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
        connectionModelsOutbound(privateTo(server.url)),
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
          connectionModelsOutbound(
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
