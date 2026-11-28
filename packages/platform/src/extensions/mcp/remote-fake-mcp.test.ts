import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { type FakeMcp, startFakeMcp } from "@werft-ai/testkit/fake-mcp";
import type { OutboundHttp } from "../ports/workspace-mcp-store.ts";
import {
  authorizationUrl,
  discover,
  exchangeCode,
  listTools,
  pkcePair,
  refreshTokens,
  registerClient,
  revokeToken,
  WorkspaceMcpRemoteError,
} from "./remote.ts";

/**
 * The compose stack's fake MCP server (packages/testkit/src/fake-mcp.ts)
 * against this client, so the E2E's server stays one this code can sign in
 * to: discovery, DCR, PKCE, the code exchange, refresh rotation and
 * revocation, on loopback.
 */
const CALLBACK =
  "http://console.test/settings/workspace/mcp-servers/s1/callback";

const http: OutboundHttp = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    ...(request.headers === undefined ? {} : { headers: request.headers }),
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "manual",
  });
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
};
const deps = { http, allowsUrl: () => true };
const random = () => randomBytes(12).toString("hex");

let fake: FakeMcp;
let origin = "";

beforeAll(async () => {
  fake = await startFakeMcp({ bearer: random(), marker: "m1" });
  origin = `http://127.0.0.1:${fake.port}`;
});
afterAll(() => fake.stop());

async function reasonOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof WorkspaceMcpRemoteError) return error.reason;
    throw error;
  }
  return "answered normally";
}

async function signIn() {
  const found = await discover(deps, `${origin}/oauth/mcp`);
  const pin = found.oauth?.pin;
  if (pin === undefined) throw new Error("no OAuth found");
  const { client } = await registerClient(deps, pin, CALLBACK);
  const pkce = pkcePair();
  const authorize = await fake.authorize(
    new Request(
      authorizationUrl({
        pin,
        client,
        redirectUri: CALLBACK,
        state: "state-1",
        challenge: pkce.challenge,
      }),
    ),
  );
  const back = new URL(authorize.headers.get("location") ?? "");
  return { pin, client, pkce, authorize, back };
}

describe("the fake MCP server's OAuth side", () => {
  test("discovery reads the challenge, the resource metadata and the server's PKCE and iss support", async () => {
    const found = await discover(deps, `${origin}/oauth/mcp`);
    expect(found.oauth).toMatchObject({
      pin: {
        issuer: origin,
        authorizationEndpoint: `${origin}/authorize`,
        tokenEndpoint: `${origin}/token`,
        registrationEndpoint: `${origin}/register`,
        revocationEndpoint: `${origin}/revoke`,
        resource: `${origin}/oauth/mcp`,
        scope: "read",
        issParameterSupported: true,
      },
      defaultScope: "read",
    });
  });

  test("registration takes only a public client that asks for refresh, as this client registers", async () => {
    const register = (body: Record<string, unknown>) =>
      fetch(`${origin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [CALLBACK], ...body }),
      });
    const full = {
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    expect((await register(full)).status).toBe(201);
    for (const left of [
      { ...full, token_endpoint_auth_method: undefined },
      { ...full, grant_types: undefined },
      { ...full, grant_types: ["authorization_code"] },
    ]) {
      const refused = await register(left);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: "invalid_client_metadata",
      });
    }
  });

  test("the browser comes back with a code, the state and the issuer; the code works once", async () => {
    const { pin, client, pkce, authorize, back } = await signIn();
    expect(authorize.status).toBe(302);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("state-1");
    expect(back.searchParams.get("iss")).toBe(origin);
    const code = back.searchParams.get("code") ?? "";
    expect(code).toStartWith("fmc_");

    const exchange = (verifier: string) =>
      exchangeCode(deps, {
        pin,
        client,
        clientSecret: null,
        code,
        verifier,
        redirectUri: CALLBACK,
        now: new Date(),
      });
    expect(await reasonOf(exchange(random()))).toBe("token_rejected");
    // The refused try spent the code, as a server that saw a guess should.
    expect(await reasonOf(exchange(pkce.verifier))).toBe("token_rejected");
  });

  test("tokens list the tools, rotate on refresh, and revoke", async () => {
    const { pin, client, pkce, back } = await signIn();
    const tokens = await exchangeCode(deps, {
      pin,
      client,
      clientSecret: null,
      code: back.searchParams.get("code") ?? "",
      verifier: pkce.verifier,
      redirectUri: CALLBACK,
      now: new Date(),
    });
    expect(tokens.accessToken).toStartWith("fmo_");
    expect(tokens.refreshToken ?? "").toStartWith("fmr_");
    expect(tokens.scope).toBe("read");
    expect(tokens.expiresAt).not.toBeNull();

    const listed = await listTools(deps, {
      url: `${origin}/oauth/mcp`,
      serverName: "tracker",
      token: tokens.accessToken,
    });
    expect(listed.tools.map((tool) => tool.name)).toEqual(["whoami", "other"]);

    const refresh = (refreshToken: string) =>
      refreshTokens(deps, {
        pin,
        client,
        clientSecret: null,
        refreshToken,
        now: new Date(),
      });
    const next = await refresh(tokens.refreshToken ?? "");
    expect(next.accessToken).not.toBe(tokens.accessToken);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect(await reasonOf(refresh(tokens.refreshToken ?? ""))).toBe(
      "token_rejected",
    );

    expect(
      await revokeToken(deps, {
        pin,
        client,
        clientSecret: null,
        token: next.accessToken,
        hint: "access_token",
      }),
    ).toBe(true);
    expect(
      await reasonOf(
        listTools(deps, {
          url: `${origin}/oauth/mcp`,
          serverName: "tracker",
          token: next.accessToken,
        }),
      ),
    ).toBe("unauthorized");
    expect(fake.workspaceCalls().oauth).toMatchObject({
      code_grants: 1,
      refresh_grants: 1,
      revocations: 1,
    });
  });

  test("the static-token server asks for no OAuth and takes an fms_ token", async () => {
    expect(await discover(deps, `${origin}/static/mcp`)).toEqual({
      url: `${origin}/static/mcp`,
      oauth: null,
    });
    const listed = await listTools(deps, {
      url: `${origin}/static/mcp`,
      serverName: "wiki",
      token: `fms_${random()}`,
    });
    expect(listed.tools).toHaveLength(2);
    expect(
      await reasonOf(
        listTools(deps, {
          url: `${origin}/static/mcp`,
          serverName: "wiki",
          token: random(),
        }),
      ),
    ).toBe("unauthorized");
    expect(fake.workspaceCalls().static.authorization_sha256).toHaveLength(1);
    // The catalog server keeps its own count.
    expect(fake.calls()).toEqual({ calls: 0, authorization_sha256: [] });
  });
});
