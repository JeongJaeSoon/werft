import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OidcUnavailableError } from "./errors.ts";
import {
  type AddressClass,
  classifyAddress,
  createProviderRequest,
  endpointProblem,
  type NetworkPolicy,
} from "./provider-http.ts";

const REFUSE: NetworkPolicy = { plainHttp: "refuse" };
const LOOPBACK: NetworkPolicy = { plainHttp: "loopback" };
const ANY: NetworkPolicy = { plainHttp: "any" };

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
      ["http://idp.internal/token", ANY, null],
      ["https://user:pass@idp.example/token", REFUSE, "invalid_url"],
      ["https://idp.example/token#frag", REFUSE, "invalid_url"],
      ["https://idp.example/token#", REFUSE, "invalid_url"],
      ["ftp://idp.example/token", ANY, "invalid_url"],
      ["/token", ANY, "invalid_url"],
      [undefined, ANY, "invalid_url"],
      [42, ANY, "invalid_url"],
    ];
  for (const [value, policy, expected] of cases) {
    test(`${String(value)} under ${policy.plainHttp} is ${expected ?? "allowed"}`, () => {
      expect(endpointProblem(value, policy)).toBe(expected);
    });
  }
});

describe("classifyAddress", () => {
  const cases: [string, AddressClass | null][] = [
    ["8.8.8.8", "public"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link_local"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["192.0.2.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fe80::1", "link_local"],
    ["fe80::1%eth0", "link_local"],
    ["ff02::1", "multicast"],
    ["fd00::1", "private"],
    ["2001:db8::1", "reserved"],
    ["2606:4700:4700::1111", "public"],
    ["2a00:1450:4001::1", "public"],
    // Outside global unicast, or set aside inside it.
    ["100::1", "reserved"],
    ["4000::1", "reserved"],
    ["fec0::1", "reserved"],
    ["64:ff9b:1::a9fe:a9fe", "reserved"],
    ["2001::1", "reserved"],
    ["2001:2::1", "reserved"],
    ["2001:1ff:ffff::1", "reserved"],
    ["2001:200::1", "public"],
    ["2002:a9fe:a9fe::1", "reserved"],
    ["3fff::1", "reserved"],
    ["3fff:1000::1", "public"],
    // IPv4 inside IPv6 is judged as the IPv4 address.
    ["::ffff:169.254.169.254", "link_local"],
    ["::ffff:a9fe:a9fe", "link_local"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:8.8.8.8", "public"],
    ["64:ff9b::a9fe:a9fe", "link_local"],
    ["::169.254.169.254", "reserved"],
    ["not-an-address", null],
    ["1.2.3", null],
    ["1.2.3.256", null],
    ["1::2::3", null],
    ["12345::1", null],
  ];
  for (const [address, expected] of cases) {
    test(`${address} is ${expected ?? "not an address"}`, () => {
      expect(classifyAddress(address)).toBe(expected);
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
    expect(response).toEqual({ status: 200, text: "ok" });
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
    expect(await request("https://idp.example/x", {}, REFUSE)).toEqual({
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
      // One address, one attempt: nothing is retried past the deadline.
      expect(signals).toHaveLength(1);
    });

    test("the default deadline is ten seconds from the start of the request", async () => {
      const original = AbortSignal.timeout;
      const asked: number[] = [];
      AbortSignal.timeout = (ms: number) => {
        asked.push(ms);
        return original.call(AbortSignal, ms);
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
