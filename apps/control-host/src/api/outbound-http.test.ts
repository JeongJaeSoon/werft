import { describe, expect, test } from "bun:test";
import { WorkspaceMcpOutboundError } from "@werft-ai/platform";
import { githubPackagesOutbound } from "./github-packages-config.ts";
import {
  createProviderRequest,
  type ResolvedAddress,
} from "./oidc/provider-http.ts";
import { oneHostOutbound } from "./outbound-http.ts";
import {
  workspaceMcpHostsFromEnv,
  workspaceMcpOutbound,
} from "./workspace-mcp.ts";

const PROXY = "http://egress-proxy:3129";

/** The real pinned request over a fake resolver and network. */
function network(
  names: Record<string, string[]>,
  answer: () => Response = () => Response.json({ ok: true }),
  options: { expired?: boolean } = {},
) {
  const sent: { url: string; init: RequestInit }[] = [];
  const deadlines: number[] = [];
  const request = createProviderRequest({
    lookup: async (host): Promise<ResolvedAddress[]> =>
      (names[host] ?? []).map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    fetch: (async (url: URL | string, init: RequestInit) => {
      sent.push({ url: String(url), init });
      // As a real fetch does with a spent signal.
      if (init.signal?.aborted) throw init.signal.reason;
      return answer();
    }) as unknown as typeof fetch,
    deadline: (timeoutMs) => {
      deadlines.push(timeoutMs);
      const controller = new AbortController();
      if (options.expired) controller.abort();
      return controller.signal;
    },
  });
  return { request, sent, deadlines };
}

/** An answer whose body breaks off after the status line. */
function cutBody(status: number): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new Error("connection reset"));
      },
    }),
    { status },
  );
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspaceMcpOutboundError);
  return error as WorkspaceMcpOutboundError;
}

describe("the egress proxy's outbound (titles and judgments)", () => {
  test("reaches the proxy on its private address over plain http, pinned to the address judged", async () => {
    const net = network({ "egress-proxy": ["172.18.0.5"] });
    const http = oneHostOutbound(PROXY, { private: true }, net.request);
    const response = await http({
      url: `${PROXY}/provider/v1/messages`,
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(net.sent.map((entry) => entry.url)).toEqual([
      "http://172.18.0.5:3129/provider/v1/messages",
    ]);
    expect((net.sent[0]?.init.headers as Record<string, string>).Host).toBe(
      "egress-proxy:3129",
    );
  });

  test("refuses every other host before sending, public https and the workspace-MCP private list's hosts alike", async () => {
    const net = network({
      "api.example.com": ["93.184.216.34"],
      "mcp.lan": ["10.0.0.7"],
      "egress-proxy": ["172.18.0.5"],
    });
    const http = oneHostOutbound(PROXY, { private: true }, net.request);
    for (const url of [
      "https://api.example.com/v1/messages",
      "http://mcp.lan:8080/mcp",
      "http://egress-proxy:3130/provider/v1/messages",
      "not a url",
    ]) {
      expect((await refusal(http({ url, method: "GET" }))).reason).toBe(
        "address_not_allowed",
      );
    }
    expect(net.sent).toHaveLength(0);
  });

  test("refuses the proxy's own name when it resolves to a metadata or link-local address", async () => {
    for (const addresses of [
      ["169.254.169.254"],
      ["172.18.0.5", "169.254.169.254"],
      ["fe80::1"],
    ]) {
      const net = network({ "egress-proxy": addresses });
      const http = oneHostOutbound(PROXY, { private: true }, net.request);
      expect(
        (await refusal(http({ url: `${PROXY}/x`, method: "GET" }))).reason,
      ).toBe("address_not_allowed");
      expect(net.sent).toHaveLength(0);
    }
  });

  test("refuses cloud metadata addresses that classify as private, on the private host too", async () => {
    for (const address of [
      "100.100.100.200",
      "fd00:ec2::254",
      "::ffff:100.100.100.200",
    ]) {
      const net = network({ "egress-proxy": [address] });
      const http = oneHostOutbound(PROXY, { private: true }, net.request);
      expect(
        (await refusal(http({ url: `${PROXY}/x`, method: "GET" }))).reason,
      ).toBe("address_not_allowed");
      expect(net.sent).toHaveLength(0);
    }
  });

  test("a body cut after the server answered is not sent again to another address", async () => {
    const net = network({ "egress-proxy": ["172.18.0.5", "172.18.0.6"] }, () =>
      cutBody(200),
    );
    const http = oneHostOutbound(PROXY, { private: true }, net.request);
    const failed = await refusal(
      http({ url: `${PROXY}/decisions/v1/decisions`, method: "POST" }),
    );
    expect(failed.reason).toBe("unreachable");
    expect(net.sent).toHaveLength(1);
  });

  test("an error answer keeps its status when its body is cut", async () => {
    const refused = network({ "egress-proxy": ["172.18.0.5"] }, () =>
      cutBody(401),
    );
    expect(
      (
        await oneHostOutbound(
          PROXY,
          { private: true },
          refused.request,
        )({
          url: `${PROXY}/x`,
          method: "POST",
        })
      ).status,
    ).toBe(401);
    const down = network({ "egress-proxy": ["172.18.0.5"] }, () =>
      cutBody(503),
    );
    const answered = await refusal(
      oneHostOutbound(
        PROXY,
        { private: true },
        down.request,
      )({
        url: `${PROXY}/x`,
        method: "POST",
      }),
    );
    expect([answered.reason, answered.detail]).toEqual([
      "answered",
      { status: 503 },
    ]);
  });

  test("hands a redirect back unfollowed", async () => {
    const net = network(
      { "egress-proxy": ["172.18.0.5"] },
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );
    const http = oneHostOutbound(PROXY, { private: true }, net.request);
    expect((await http({ url: `${PROXY}/x`, method: "GET" })).status).toBe(302);
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]?.init.redirect).toBe("manual");
  });

  test("runs under the request's own deadline, ten seconds when it names none", async () => {
    const net = network({ "egress-proxy": ["172.18.0.5"] });
    const http = oneHostOutbound(PROXY, { private: true }, net.request);
    await http({ url: `${PROXY}/x`, method: "POST", timeoutMs: 25_000 });
    await http({ url: `${PROXY}/x`, method: "POST" });
    expect(net.deadlines).toEqual([25_000, 10_000]);
  });

  test("tells a 5xx's status and a deadline that ran out", async () => {
    const failing = network(
      { "egress-proxy": ["172.18.0.5"] },
      () => new Response("down", { status: 503 }),
    );
    const answered = await refusal(
      oneHostOutbound(
        PROXY,
        { private: true },
        failing.request,
      )({
        url: `${PROXY}/x`,
        method: "GET",
      }),
    );
    expect([answered.reason, answered.detail]).toEqual([
      "answered",
      { status: 503 },
    ]);
    const late = network({ "egress-proxy": ["172.18.0.5"] }, undefined, {
      expired: true,
    });
    const timedOut = await refusal(
      oneHostOutbound(
        PROXY,
        { private: true },
        late.request,
      )({
        url: `${PROXY}/x`,
        method: "GET",
      }),
    );
    expect([timedOut.reason, timedOut.detail]).toEqual([
      "unreachable",
      { timedOut: true },
    ]);
  });

  test("the workspace-MCP outbound does not reach the proxy, its private list never naming it", async () => {
    const net = network({ "egress-proxy": ["172.18.0.5"] });
    const hosts = workspaceMcpHostsFromEnv({
      EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "mcp.lan:8080",
    });
    expect(
      (
        await refusal(
          workspaceMcpOutbound(
            hosts,
            net.request,
          )({ url: `${PROXY}/provider/v1/messages`, method: "POST" }),
        )
      ).reason,
    ).toBe("address_not_allowed");
    expect(net.sent).toHaveLength(0);
  });
});

describe("the GitHub Packages token check's outbound", () => {
  test("GitHub's own API is held to https and a public address", async () => {
    const net = network({ "api.github.com": ["140.82.112.6"] });
    const http = githubPackagesOutbound("https://api.github.com", net.request);
    expect(
      (await http({ url: "https://api.github.com/user", method: "GET" }))
        .status,
    ).toBe(200);

    const inside = network({ "api.github.com": ["10.0.0.5"] });
    expect(
      (
        await refusal(
          githubPackagesOutbound(
            "https://api.github.com",
            inside.request,
          )({
            url: "https://api.github.com/user",
            method: "GET",
          }),
        )
      ).reason,
    ).toBe("address_not_allowed");
    expect(
      (
        await refusal(
          http({ url: "http://api.github.com/user", method: "GET" }),
        )
      ).reason,
    ).toBe("address_not_allowed");
    expect(inside.sent).toHaveLength(0);
    expect(net.sent).toHaveLength(1);
  });

  test("another spelling of GitHub's own API URL is still held to a public address", async () => {
    for (const base of [
      "https://API.GITHUB.COM",
      "https://api.github.com:443",
      "https://api.github.com.",
    ]) {
      const net = network({
        "api.github.com": ["10.0.0.5"],
        "API.GITHUB.COM": ["10.0.0.5"],
        "api.github.com.": ["10.0.0.5"],
      });
      const failed = await refusal(
        githubPackagesOutbound(
          base,
          net.request,
        )({
          url: `${base}/user`,
          method: "GET",
        }),
      );
      expect(failed.reason).toBe("address_not_allowed");
      expect(net.sent).toHaveLength(0);
    }
  });

  test("an API URL the operator set may be plain http and private, and is the only host reached", async () => {
    const net = network({
      "ghes.lan": ["10.0.0.9"],
      "api.github.com": ["140.82.112.6"],
    });
    const http = githubPackagesOutbound("http://ghes.lan:8080", net.request);
    expect(
      (await http({ url: "http://ghes.lan:8080/user", method: "GET" })).status,
    ).toBe(200);
    expect(
      (
        await refusal(
          http({ url: "https://api.github.com/user", method: "GET" }),
        )
      ).reason,
    ).toBe("address_not_allowed");
    expect(net.sent.map((entry) => entry.url)).toEqual([
      "http://10.0.0.9:8080/user",
    ]);
  });
});
