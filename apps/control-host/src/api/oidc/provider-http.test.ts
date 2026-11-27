import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OidcUnavailableError } from "./errors.ts";
import {
  createProviderRequest,
  endpointProblem,
  type NetworkPolicy,
} from "./provider-http.ts";

const REFUSE: NetworkPolicy = { plainHttp: "refuse" };
const LOOPBACK: NetworkPolicy = { plainHttp: "loopback" };
const NARROW: NetworkPolicy = {
  plainHttp: "refuse",
  privateHosts: ["mcp.lan:8080"],
};
// The narrow policy ignores plainHttp, so "loopback" grants nothing there.
const NARROW_LOOPBACK: NetworkPolicy = { ...NARROW, plainHttp: "loopback" };

// Each cloud's documented metadata address (sources in ip-address.ts).
const CLOUD_METADATA: readonly [cloud: string, address: string][] = [
  ["AWS EC2", "169.254.169.254"],
  ["AWS EC2 IPv6", "fd00:ec2::254"],
  ["AWS ECS", "169.254.170.2"],
  ["AWS EKS Pod Identity", "169.254.170.23"],
  ["AWS EKS Pod Identity IPv6", "fd00:ec2::23"],
  ["GCP", "169.254.169.254"],
  ["GCP IPv6", "fd20:ce::254"],
  ["Azure", "169.254.169.254"],
  ["Alibaba", "100.100.100.200"],
  ["Oracle", "169.254.169.254"],
  ["Oracle IPv6", "fd00:c1::a9fe:a9fe"],
  ["Oracle Compute Classic", "192.0.0.192"],
  ["Scaleway", "169.254.42.42"],
  ["Scaleway IPv6", "fd00:42::42"],
  ["DigitalOcean", "169.254.169.254"],
  ["Hetzner", "169.254.169.254"],
  ["Hetzner IPv6", "fe80::a9fe:a9fe"],
  ["OpenStack", "169.254.169.254"],
  ["OpenStack IPv6", "fe80::a9fe:a9fe"],
];

describe("endpointProblem", () => {
  const cases: [unknown, NetworkPolicy, ReturnType<typeof endpointProblem>][] =
    [
      ["https://idp.example/oidc", REFUSE, null],
      ["https://idp.example:8443/token?x=1", REFUSE, null],
      ["http://idp.example/token", REFUSE, "insecure_endpoint"],
      ["http://localhost:8080/token", REFUSE, "insecure_endpoint"],
      ["http://localhost:8080/token", LOOPBACK, null],
      ["http://127.0.0.1:8080/token", LOOPBACK, null],
      ["http://[::1]:8080/token", LOOPBACK, null],
      ["http://idp.internal/token", LOOPBACK, "insecure_endpoint"],
      ["http://localhost.evil.example/token", LOOPBACK, "insecure_endpoint"],
      ["https://user:pass@idp.example/token", REFUSE, "invalid_url"],
      ["https://idp.example/token#frag", REFUSE, "invalid_url"],
      ["https://idp.example/token#", REFUSE, "invalid_url"],
      ["ftp://idp.example/token", LOOPBACK, "invalid_url"],
      ["/token", LOOPBACK, "invalid_url"],
      [undefined, LOOPBACK, "invalid_url"],
      [42, LOOPBACK, "invalid_url"],
      ["http://mcp.lan:8080/mcp", NARROW, null],
      ["http://MCP.LAN:8080/mcp", NARROW, null],
      ["http://mcp.lan/mcp", NARROW, "insecure_endpoint"],
      ["http://localhost:8080/mcp", NARROW_LOOPBACK, "insecure_endpoint"],
      ["https://mcp.example/mcp", NARROW, null],
    ];
  for (const [value, policy, expected] of cases) {
    test(`${String(value)} under ${policy.plainHttp} is ${expected ?? "allowed"}`, () => {
      expect(endpointProblem(value, policy)).toBe(expected);
    });
  }
});

type Sent = { url: string; init: Record<string, unknown> };

function harness(
  answers: Record<string, { address: string; family: number }[]>,
  respond: (sent: Sent) => Response | Promise<Response> = () =>
    new Response("ok"),
) {
  const sent: Sent[] = [];
  const request = createProviderRequest({
    lookup: async (host) => {
      const found = answers[host];
      if (!found) throw new Error("ENOTFOUND");
      return found;
    },
    fetch: (async (input: URL | string, init?: Record<string, unknown>) => {
      const entry = { url: String(input), init: init ?? {} };
      sent.push(entry);
      return respond(entry);
    }) as unknown as typeof fetch,
  });
  return { request, sent };
}

async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof OidcUnavailableError) return error.kind;
    throw error;
  }
  return "answered normally";
}

describe("provider request", () => {
  test("connects to the judged address and keeps the name for Host and TLS", async () => {
    const { request, sent } = harness({
      "idp.example": [{ address: "203.0.114.7", family: 4 }],
    });
    const response = await request(
      "https://idp.example:8443/token?a=1",
      { method: "POST", headers: { Accept: "application/json" }, body: "x=1" },
      REFUSE,
    );
    expect(response).toMatchObject({ status: 200, text: "ok" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://203.0.114.7:8443/token?a=1");
    expect(sent[0]?.init).toMatchObject({
      method: "POST",
      body: "x=1",
      redirect: "manual",
      headers: { Accept: "application/json", Host: "idp.example:8443" },
      tls: { serverName: "idp.example" },
    });
  });

  test("an IPv6 answer is bracketed", async () => {
    const { request, sent } = harness({
      "idp.example": [{ address: "2606:4700:4700::1111", family: 6 }],
    });
    await request("https://idp.example/jwks", {}, REFUSE);
    expect(sent[0]?.url).toBe("https://[2606:4700:4700::1111]/jwks");
  });

  test("a private address is allowed: a company's own provider lives there", async () => {
    const { request, sent } = harness({
      "idp.corp": [{ address: "10.20.30.40", family: 4 }],
    });
    await request("https://idp.corp/jwks", {}, REFUSE);
    expect(sent[0]?.url).toBe("https://10.20.30.40/jwks");
  });

  const refused: [string, { address: string; family: number }[]][] = [
    ["a link-local address", [{ address: "169.254.169.254", family: 4 }]],
    ["a link-local IPv6 address", [{ address: "fe80::1", family: 6 }]],
    [
      "link-local in IPv6 clothes",
      [{ address: "::ffff:169.254.169.254", family: 6 }],
    ],
    ["a multicast address", [{ address: "224.0.0.1", family: 4 }]],
    ["a reserved address", [{ address: "240.0.0.1", family: 4 }]],
    ["a discard-only IPv6 address", [{ address: "100::1", family: 6 }]],
    ["a benchmarking IPv6 address", [{ address: "2001:2::1", family: 6 }]],
    ["an unassigned IPv6 address", [{ address: "4000::1", family: 6 }]],
    [
      "a 6to4 address carrying link-local",
      [{ address: "2002:a9fe:a9fe::1", family: 6 }],
    ],
    ["the unspecified address", [{ address: "0.0.0.0", family: 4 }]],
    [
      "loopback outside a local installation",
      [{ address: "127.0.0.1", family: 4 }],
    ],
    [
      "a refused address behind an allowed first answer",
      [
        { address: "203.0.114.7", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    ],
    ["text that is not an address", [{ address: "bogus", family: 4 }]],
    ["an ECS credentials address", [{ address: "169.254.170.2", family: 4 }]],
    [
      "a metadata address that would be carrier-grade NAT",
      [{ address: "100.100.100.200", family: 4 }],
    ],
    [
      "a metadata address inside fc00::/7",
      [{ address: "fd00:ec2::254", family: 6 }],
    ],
    [
      "a metadata address with a zone id",
      [{ address: "fd00:ec2::254%eth0", family: 6 }],
    ],
    ["metadata through NAT64", [{ address: "64:ff9b::a9fe:a9fe", family: 6 }]],
    // Some resolvers read a leading zero as octal; this one was taken as
    // private 10.0.0.1 before the classes were shared with the egress proxy.
    ["a leading-zero IPv4 address", [{ address: "010.0.0.1", family: 4 }]],
  ];
  for (const [what, addresses] of refused) {
    test(`a name resolving to ${what} is refused before anything is sent`, async () => {
      const { request, sent } = harness({ "idp.example": addresses });
      expect(
        await refusal(request("https://idp.example/token", {}, REFUSE)),
      ).toBe("address_not_allowed");
      expect(sent).toHaveLength(0);
    });
  }

  describe("the narrow policy for a URL a workspace admin chose", () => {
    const narrow = (address: string) =>
      harness({
        "mcp.example": [{ address, family: 4 }],
        "mcp.lan": [{ address, family: 4 }],
      });

    test("a private or loopback answer is refused for a host off the private list", async () => {
      for (const address of ["10.20.30.40", "127.0.0.1"]) {
        const { request, sent } = narrow(address);
        expect(
          await refusal(request("https://mcp.example/mcp", {}, NARROW)),
        ).toBe("address_not_allowed");
        expect(sent).toHaveLength(0);
      }
    });

    test("a host on the private list may resolve to a private address over http", async () => {
      const { request, sent } = narrow("10.20.30.40");
      await request("http://mcp.lan:8080/mcp", {}, NARROW);
      expect(sent[0]?.url).toBe("http://10.20.30.40:8080/mcp");
    });

    test.each(CLOUD_METADATA)(
      "%s: %s is refused on the private list",
      async (_, address) => {
        const { request, sent } = harness({
          "mcp.lan": [{ address, family: address.includes(":") ? 6 : 4 }],
        });
        expect(
          await refusal(request("http://mcp.lan:8080/mcp", {}, NARROW)),
        ).toBe("address_not_allowed");
        expect(sent).toHaveLength(0);
      },
    );

    test("the private list does not lift the refusal of any link-local address", async () => {
      for (const address of ["169.254.0.1", "169.254.255.254", "fe80::1"]) {
        const { request, sent } = harness({
          "mcp.lan": [{ address, family: address.includes(":") ? 6 : 4 }],
        });
        expect(
          await refusal(request("http://mcp.lan:8080/mcp", {}, NARROW)),
          address,
        ).toBe("address_not_allowed");
        expect(sent).toHaveLength(0);
      }
    });

    test("a metadata address written as one decimal, octal or hex number is refused", async () => {
      const policy: NetworkPolicy = {
        plainHttp: "refuse",
        privateHosts: ["100.100.100.200:8080"],
      };
      for (const url of [
        "http://1684301000:8080/mcp",
        "http://0x646464c8:8080/mcp",
        "http://0144.0144.0144.0310:8080/mcp",
        "http://100.100.100.200.:8080/mcp",
      ]) {
        const { request, sent } = harness({
          "100.100.100.200": [{ address: "100.100.100.200", family: 4 }],
        });
        expect(await refusal(request(url, {}, policy)), url).toBe(
          "address_not_allowed",
        );
        expect(sent).toHaveLength(0);
      }
    });

    test("the private list does not lift the metadata refusal", async () => {
      for (const [address, family] of [
        ["100.100.100.200", 4],
        ["fd00:ec2::254", 6],
        ["fd00:ec2::23", 6],
        ["169.254.170.2", 4],
        ["::ffff:100.100.100.200", 6],
        ["64:ff9b::6464:64c8", 6],
      ] as const) {
        const { request, sent } = harness({
          "mcp.lan": [{ address, family }],
        });
        expect(
          await refusal(request("http://mcp.lan:8080/mcp", {}, NARROW)),
          address,
        ).toBe("address_not_allowed");
        expect(sent).toHaveLength(0);
      }
    });

    test("a metadata name is refused before it is looked up, on the private list too", async () => {
      const policy: NetworkPolicy = {
        plainHttp: "refuse",
        privateHosts: ["metadata.google.internal:80", "metadata:80"],
      };
      for (const url of [
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://METADATA.google.internal./computeMetadata/v1/",
        "http://metadata/latest/meta-data/",
        "http://metadata.goog/computeMetadata/v1/",
        "https://instance-data.ec2.internal/latest/meta-data/",
      ]) {
        const asked: string[] = [];
        const request = createProviderRequest({
          lookup: async (host) => {
            asked.push(host);
            return [{ address: "10.0.0.5", family: 4 }];
          },
          fetch: (async () => {
            throw new Error("nothing may be sent");
          }) as unknown as typeof fetch,
        });
        expect(await refusal(request(url, {}, policy)), url).toBe(
          "address_not_allowed",
        );
        expect(asked, url).toEqual([]);
      }
    });

    test("the private list does not lift the link-local refusal", async () => {
      const { request, sent } = narrow("169.254.169.254");
      expect(
        await refusal(request("http://mcp.lan:8080/mcp", {}, NARROW)),
      ).toBe("address_not_allowed");
      expect(sent).toHaveLength(0);
    });

    test("the answer carries its headers", async () => {
      const { request } = harness(
        { "mcp.example": [{ address: "203.0.114.7", family: 4 }] },
        () => new Response("{}", { headers: { "Mcp-Session-Id": "s-1" } }),
      );
      const response = await request("https://mcp.example/mcp", {}, NARROW);
      expect(response.headers.get("mcp-session-id")).toBe("s-1");
    });
  });

  test("a plain-http or malformed URL is refused before the name is resolved", async () => {
    const { request, sent } = harness({});
    for (const url of [
      "http://idp.example/token",
      "https://user:pw@idp.example/token",
      "nonsense",
    ]) {
      expect(await refusal(request(url, {}, REFUSE))).toBe(
        "address_not_allowed",
      );
    }
    expect(sent).toHaveLength(0);
  });

  test("a name that does not resolve, or resolves to nothing, is unreachable", async () => {
    const { request } = harness({ "empty.example": [] });
    expect(await refusal(request("https://gone.example/x", {}, REFUSE))).toBe(
      "unreachable",
    );
    expect(await refusal(request("https://empty.example/x", {}, REFUSE))).toBe(
      "unreachable",
    );
  });

  test("the next judged address is tried when one cannot be reached", async () => {
    const { request, sent } = harness(
      {
        "idp.example": [
          { address: "2606:4700:4700::1111", family: 6 },
          { address: "203.0.114.7", family: 4 },
        ],
      },
      ({ url }) => {
        if (url.includes("[")) throw new Error("ECONNREFUSED");
        return new Response("v4");
      },
    );
    expect(await request("https://idp.example/x", {}, REFUSE)).toMatchObject({
      status: 200,
      text: "v4",
    });
    expect(sent.map((entry) => entry.url)).toEqual([
      "https://[2606:4700:4700::1111]/x",
      "https://203.0.114.7/x",
    ]);
  });

  test("a redirect is returned, not followed; 5xx and an oversized body are unavailable", async () => {
    const answers = { "idp.example": [{ address: "203.0.114.7", family: 4 }] };
    const redirect = harness(
      answers,
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/" },
        }),
    );
    expect(
      (await redirect.request("https://idp.example/x", {}, REFUSE)).status,
    ).toBe(302);
    expect(redirect.sent).toHaveLength(1);

    const failing = harness(
      answers,
      () => new Response("down", { status: 503 }),
    );
    expect(
      await refusal(failing.request("https://idp.example/x", {}, REFUSE)),
    ).toBe("answered");

    const huge = harness(
      answers,
      () => new Response(new Uint8Array(1024 * 1024 + 1)),
    );
    expect(
      await refusal(huge.request("https://idp.example/x", {}, REFUSE)),
    ).toBe("unreachable");
  });

  describe("one deadline for the whole request", () => {
    const answers = [{ address: "203.0.114.7", family: 4 }];
    // No timers: the test owns the deadline and the moment the name
    // resolves, so the order of events is the same on any machine.
    function controlled() {
      const deadline = new AbortController();
      const resolved = Promise.withResolvers<typeof answers>();
      const signals: (AbortSignal | null | undefined)[] = [];
      const request = createProviderRequest({
        deadline: () => deadline.signal,
        lookup: () => resolved.promise,
        fetch: ((_input: URL | string, init?: RequestInit) => {
          signals.push(init?.signal);
          return new Promise<Response>((_, reject) => {
            if (init?.signal?.aborted) reject(new Error("aborted"));
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          });
        }) as unknown as typeof fetch,
      });
      return { deadline, resolved, signals, request };
    }
    const turn = () => new Promise((resolve) => setImmediate(resolve));

    test("a name lookup still unanswered at the deadline is given up on, and its late answer sends nothing", async () => {
      const { deadline, resolved, signals, request } = controlled();
      const run = refusal(request("https://idp.example/x", {}, REFUSE));
      await turn();
      deadline.abort();
      expect(await run).toBe("unreachable");
      resolved.resolve(answers);
      await turn();
      expect(signals).toHaveLength(0);
    });

    test("the connection runs under the deadline that started before the name was resolved", async () => {
      const { deadline, resolved, signals, request } = controlled();
      const run = refusal(request("https://idp.example/x", {}, REFUSE));
      resolved.resolve(answers);
      await turn();
      // The request is on the wire, holding the same signal.
      expect(signals).toEqual([deadline.signal]);
      deadline.abort();
      expect(await run).toBe("unreachable");
    });

    test("the next address is not tried once the deadline has passed", async () => {
      const { deadline, resolved, signals, request } = controlled();
      const run = refusal(request("https://idp.example/x", {}, REFUSE));
      resolved.resolve([
        { address: "203.0.114.7", family: 4 },
        { address: "203.0.114.8", family: 4 },
      ]);
      await turn();
      expect(signals).toHaveLength(1);
      // The first connection fails because time ran out, not because the
      // address is down.
      deadline.abort();
      expect(await run).toBe("unreachable");
      await turn();
      expect(signals).toHaveLength(1);
    });

    test("the default deadline is ten seconds from the start of the request", async () => {
      const original = AbortSignal.timeout;
      const asked: number[] = [];
      AbortSignal.timeout = (ms: number) => {
        asked.push(ms);
        return new AbortController().signal;
      };
      try {
        const request = createProviderRequest({
          lookup: async () => {
            // Started before the name is resolved.
            expect(asked).toEqual([10_000]);
            return answers;
          },
          fetch: (async () => new Response("ok")) as unknown as typeof fetch,
        });
        await request("https://idp.example/x", {}, REFUSE);
        expect(asked).toEqual([10_000]);
      } finally {
        AbortSignal.timeout = original;
      }
    });
  });

  describe("against a real listener", () => {
    let server: ReturnType<typeof Bun.serve>;
    beforeAll(() => {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (incoming) =>
          Response.json({
            host: incoming.headers.get("Host"),
            path: new URL(incoming.url).pathname,
          }),
      });
    });
    afterAll(() => server.stop(true));

    test("a loopback name reaches the listener with its own Host header", async () => {
      const request = createProviderRequest();
      const response = await request(
        `http://localhost:${server.port}/jwks`,
        {},
        LOOPBACK,
      );
      expect(JSON.parse(response.text)).toEqual({
        host: `localhost:${server.port}`,
        path: "/jwks",
      });
    });

    test("the same listener is refused where plain http is not allowed", async () => {
      const request = createProviderRequest();
      expect(
        await refusal(
          request(`http://localhost:${server.port}/jwks`, {}, REFUSE),
        ),
      ).toBe("address_not_allowed");
    });
  });
});
