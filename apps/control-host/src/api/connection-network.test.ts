import { describe, expect, test } from "bun:test";
import { OutboundRefusedError } from "@werft-ai/platform";
import {
  carryOperatorPrivateConnections,
  connectionNetworkCheck,
  privateConnectionOutbound,
} from "./connection-network.ts";
import { createProviderRequest } from "./oidc/provider-http.ts";

const resolving =
  (answers: Record<string, string[]>, asked: string[] = []) =>
  async (host: string) => {
    asked.push(host);
    const answer = answers[host];
    if (answer === undefined) throw new Error("ENOTFOUND");
    return answer.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  };
const own = (hosts: readonly string[] | null) => async () => hosts;

describe("connectionNetworkCheck", () => {
  const lookup = resolving({
    "api.example.com": ["93.184.216.34"],
    "llm.corp": ["10.0.0.5", "fd12::5"],
    "mixed.corp": ["10.0.0.5", "93.184.216.34"],
    "rebound.corp": ["169.254.169.254"],
    "local.corp": ["127.0.0.1"],
    "db.corp": ["10.0.0.7"],
    postgres: ["10.0.0.9"],
    "10.0.0.5": ["10.0.0.5"],
    "nothing.corp": [],
  });
  const check = connectionNetworkCheck(own(["postgres", "10.0.0.7"]), lookup);

  test("the network is what every address of the name is", async () => {
    expect(await check("https://api.example.com")).toEqual({
      network: "public",
    });
    expect(await check("http://llm.corp:4000/v1")).toEqual({
      network: "private",
    });
    expect(await check("http://10.0.0.5:4000")).toEqual({ network: "private" });
  });

  test("mixed answers, what is never reached, and the installation's own hosts may not be registered", async () => {
    for (const endpoint of [
      "http://mixed.corp:4000",
      "http://rebound.corp:4000",
      "http://local.corp:4000",
      // By what it resolves to, and by its own name.
      "http://db.corp:4000",
      "http://postgres:5432",
      "http://metadata.google.internal",
    ]) {
      expect([endpoint, await check(endpoint)]).toEqual([
        endpoint,
        { problem: "address_not_allowed" },
      ]);
    }
  });

  test("a metadata name or one of the installation's own is refused before it is looked up", async () => {
    const asked: string[] = [];
    const early = connectionNetworkCheck(
      own(["postgres"]),
      resolving({ postgres: ["10.0.0.9"] }, asked),
    );
    for (const endpoint of [
      "http://metadata.google.internal",
      "http://Metadata.:80",
      "http://POSTGRES.:5432",
    ]) {
      expect(await early(endpoint)).toEqual({ problem: "address_not_allowed" });
    }
    expect(asked).toEqual([]);
  });

  test("a name that does not resolve is unreachable", async () => {
    expect(await check("http://unknown.corp:4000")).toEqual({
      problem: "unreachable",
    });
    expect(await check("http://nothing.corp:4000")).toEqual({
      problem: "unreachable",
    });
  });

  test("without the installation's hosts a private endpoint is not registered; a public one is", async () => {
    const blind = connectionNetworkCheck(own(null), lookup);
    expect(await blind("http://llm.corp:4000")).toEqual({
      problem: "installation_hosts_unavailable",
    });
    expect(await blind("https://api.example.com")).toEqual({
      network: "public",
    });
    // What is never reached stays refused, whatever else is unknown.
    expect(await blind("http://local.corp:4000")).toEqual({
      problem: "address_not_allowed",
    });
  });
});

describe("privateConnectionOutbound", () => {
  function sending(answers: Record<string, string[]>) {
    const sent: string[] = [];
    const request = createProviderRequest({
      lookup: resolving(answers),
      fetch: (async (target: URL | string) => {
        sent.push(String(target));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { sent, request };
  }
  const get = (url: string) => ({ url, method: "GET" as const });

  test("plain http to private addresses, pinned to the address that was judged", async () => {
    const { sent, request } = sending({ "llm.corp": ["10.0.0.5"] });
    const outbound = privateConnectionOutbound(own(["postgres"]), request);
    expect((await outbound(get("http://llm.corp:4000/v1/models"))).status).toBe(
      200,
    );
    expect(sent).toEqual(["http://10.0.0.5:4000/v1/models"]);
  });

  test("a name that now answers anything else is not asked", async () => {
    for (const addresses of [
      ["93.184.216.34"],
      ["10.0.0.5", "93.184.216.34"],
      ["127.0.0.1"],
      ["169.254.169.254"],
      ["::ffff:10.0.0.5"],
      // One of the installation's own.
      ["10.0.0.7"],
    ]) {
      const { sent, request } = sending({ "llm.corp": addresses });
      const outbound = privateConnectionOutbound(own(["10.0.0.7"]), request);
      const error = await outbound(get("http://llm.corp:4000/v1/models")).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(OutboundRefusedError);
      expect([addresses, (error as OutboundRefusedError).reason]).toEqual([
        addresses,
        "address_not_allowed",
      ]);
      expect(sent).toEqual([]);
    }
  });

  test("nothing is sent while the installation's hosts cannot be told", async () => {
    const { sent, request } = sending({ "llm.corp": ["10.0.0.5"] });
    const outbound = privateConnectionOutbound(own(null), request);
    await expect(
      outbound(get("http://llm.corp:4000/v1/models")),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
    expect(sent).toEqual([]);
  });
});

describe("carryOperatorPrivateConnections", () => {
  const entry = (endpoint: string) => ({ kind: "litellm", endpoint });
  function pass(
    rows: Array<{ id: string; entry: unknown; network?: string | null }>,
    judged: Record<string, "public" | "private" | "refused">,
    privateHosts = ["llm.corp:4000", "sidecar.corp:4000", "moved.corp:4000"],
  ) {
    const carried: string[] = [];
    const asked: string[] = [];
    return {
      asked,
      carriedBy: carried,
      run: carryOperatorPrivateConnections({
        rows: async () => rows,
        carry: async (id) => {
          carried.push(id);
          return { outcome: "carried" };
        },
        privateHosts,
        network: async (endpoint) => {
          asked.push(endpoint);
          const verdict = judged[new URL(endpoint).hostname];
          return verdict === "refused" || verdict === undefined
            ? { problem: "address_not_allowed" }
            : { network: verdict };
        },
      }),
    };
  }

  test("a row on the operator's private allowlist that resolves privately is kept as private, with no one asked", async () => {
    const { run, carriedBy } = pass(
      [
        {
          id: "inside",
          entry: entry("http://LLM.corp.:4000/v1"),
          network: null,
        },
        { id: "outside", entry: entry("https://api.example.com") },
      ],
      { "llm.corp.": "private" },
    );
    expect(await run).toEqual({ carried: ["inside"], left: [] });
    expect(carriedBy).toEqual(["inside"]);
  });

  test("a listed row the private rules refuse stays on the proxy's lists and is named", async () => {
    const { run, carriedBy } = pass(
      [
        // Loopback, or one of the installation's own hosts.
        { id: "sidecar", entry: entry("http://sidecar.corp:4000") },
        // Listed as private, resolving publicly now.
        { id: "moved", entry: entry("http://moved.corp:4000") },
      ],
      { "sidecar.corp": "refused", "moved.corp": "public" },
    );
    expect(await run).toEqual({ carried: [], left: ["sidecar", "moved"] });
    expect(carriedBy).toEqual([]);
  });

  test("a row that already says its network, one off the list, and one with no endpoint to read are not looked at", async () => {
    const { run, asked } = pass(
      [
        {
          id: "kept",
          entry: entry("http://llm.corp:4000"),
          network: "private",
        },
        {
          id: "public",
          entry: entry("http://llm.corp:4000"),
          network: "public",
        },
        { id: "other-port", entry: entry("http://llm.corp:4001") },
        { id: "broken", entry: { kind: "litellm" } },
        { id: "null", entry: null },
      ],
      { "llm.corp": "private" },
    );
    expect(await run).toEqual({ carried: [], left: [] });
    expect(asked).toEqual([]);
  });

  test("with no private allowlist nothing is read", async () => {
    let read = 0;
    expect(
      await carryOperatorPrivateConnections({
        rows: async () => {
          read += 1;
          return [];
        },
        carry: async () => ({ outcome: "unchanged" }),
        privateHosts: [],
        network: async () => ({ network: "private" }),
      }),
    ).toEqual({ carried: [], left: [] });
    expect(read).toBe(0);
  });

  test("a row another replica carried a moment ago is not counted twice", async () => {
    expect(
      await carryOperatorPrivateConnections({
        rows: async () => [
          { id: "inside", entry: entry("http://llm.corp:4000") },
        ],
        carry: async () => ({ outcome: "unchanged" }),
        privateHosts: ["llm.corp:4000"],
        network: async () => ({ network: "private" }),
      }),
    ).toEqual({ carried: [], left: [] });
  });
});
