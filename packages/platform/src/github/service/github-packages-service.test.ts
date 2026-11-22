import { describe, expect, test } from "bun:test";
import {
  type OutboundRequest,
  WorkspaceMcpOutboundError,
} from "../../ports/outbound-http.ts";
import {
  createGitHubPackagesTokenVerifier,
  expiryOf,
  scopesOf,
} from "./github-packages-service.ts";

function verifierAnswering(
  status: number,
  headers: Record<string, string>,
  body: unknown = { login: "acme-packages-bot" },
) {
  const asked: OutboundRequest[] = [];
  const verifier = createGitHubPackagesTokenVerifier({
    apiBase: "http://fake-github.invalid/",
    http: async (request) => {
      asked.push(request);
      return {
        status,
        text: JSON.stringify(body),
        headers: new Headers(headers),
      };
    },
  });
  return { verifier, asked };
}

describe("the GitHub Packages token verifier", () => {
  test("a classic token with read:packages alone is taken, with its login and expiry", async () => {
    const { verifier, asked } = verifierAnswering(200, {
      "x-oauth-scopes": "read:packages",
      "github-authentication-token-expiration": "2027-01-30 09:00:00 +0900",
    });
    expect(await verifier.verify("fake-classic")).toEqual({
      outcome: "ok",
      facts: {
        login: "acme-packages-bot",
        expiresAt: new Date("2027-01-30T00:00:00Z"),
      },
    });
    expect(asked[0]?.url).toBe("http://fake-github.invalid/user");
    expect(asked[0]?.method).toBe("GET");
    expect(asked[0]?.timeoutMs).toBe(10_000);
    expect(asked[0]?.headers?.authorization).toBe("Bearer fake-classic");
  });

  test("a wider token, or one with no scopes header, is rejected for its scopes", async () => {
    expect(
      await verifierAnswering(200, {
        "x-oauth-scopes": "read:packages, repo",
      }).verifier.verify("x"),
    ).toEqual({
      outcome: "rejected",
      reason: "scopes",
      scopes: ["read:packages", "repo"],
    });
    expect(await verifierAnswering(200, {}).verifier.verify("x")).toEqual({
      outcome: "rejected",
      reason: "scopes",
      scopes: [],
    });
  });

  test("GitHub refusing the token rejects it; anything else is unavailable", async () => {
    expect(await verifierAnswering(401, {}).verifier.verify("x")).toMatchObject(
      { outcome: "rejected", reason: "invalid" },
    );
    expect(await verifierAnswering(302, {}).verifier.verify("x")).toEqual({
      outcome: "unavailable",
    });
    for (const error of [
      new WorkspaceMcpOutboundError("answered", "Provider answered 502", {
        status: 502,
      }),
      new WorkspaceMcpOutboundError("address_not_allowed", "not the API host"),
      new TypeError("network"),
    ]) {
      const thrown = createGitHubPackagesTokenVerifier({
        apiBase: "http://fake-github.invalid",
        http: async () => {
          throw error;
        },
      });
      expect(await thrown.verify("x")).toEqual({ outcome: "unavailable" });
    }
  });

  test("scopes and expiry headers are read as GitHub writes them", () => {
    expect(scopesOf(null)).toBeNull();
    expect(scopesOf("")).toEqual([]);
    expect(expiryOf("2026-12-31 00:00:00 UTC")).toEqual(
      new Date("2026-12-31T00:00:00Z"),
    );
    expect(expiryOf("2026-12-31 00:00:00 -05:00")).toEqual(
      new Date("2026-12-31T05:00:00Z"),
    );
    expect(expiryOf("never")).toBeNull();
    expect(expiryOf(null)).toBeNull();
  });
});
