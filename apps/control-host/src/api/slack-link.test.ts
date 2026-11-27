import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type MockSlackOidc,
  startMockSlackOidc,
} from "@werft-ai/testkit/mock-slack-oidc";
import {
  exchangeSlackCode,
  SlackOidcRejectedError,
  SlackOidcUnavailableError,
  slackLinkAuthorizeUrl,
} from "../wiring/chat-slack.ts";
import { createProviderRequest } from "./oidc/index.ts";
import {
  createSlackOidcTransport,
  signInWithSlackOff,
  slackNetworkPolicy,
} from "./slack-link.ts";

const REDIRECT_URI = "https://werft.example/settings/linked-accounts/slack";

describe("signInWithSlackOff", () => {
  test("silent when the console origin is known and link apps can be made", () => {
    expect(signInWithSlackOff("https://werft.example", true)).toBeNull();
  });

  test("off without the console origin", () => {
    expect(signInWithSlackOff(null, true)).toContain("CONSOLE_ORIGIN");
  });

  test("off without a secret store: no env client stands in for the link app", () => {
    expect(signInWithSlackOff("https://werft.example", false)).toContain(
      "PLATFORM_SECRET_KEY",
    );
  });
});

describe("slackNetworkPolicy", () => {
  test("Slack itself: https and a public address only", () => {
    expect(slackNetworkPolicy("https://slack.com")).toEqual({
      plainHttp: "refuse",
    });
  });

  test("a mock IdP is the one host allowed plain http on a private address", () => {
    expect(slackNetworkPolicy("http://mock-slack:4020")).toEqual({
      plainHttp: "refuse",
      privateHosts: ["mock-slack:4020"],
    });
  });
});

describe("exchangeSlackCode on the platform's OIDC client", () => {
  let idp: MockSlackOidc;
  const account = { teamId: "T0TEAM", userId: "U0USER" };

  beforeAll(async () => {
    idp = await startMockSlackOidc({ account });
  });
  afterAll(async () => {
    await idp.stop();
  });

  const config = () => ({
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    redirectUri: REDIRECT_URI,
    issuer: idp.url,
  });
  const transport = (now?: () => number) =>
    createSlackOidcTransport(idp.url, now ? { now } : {});
  const exchange = (code: string, nonce: string, now?: () => number) =>
    exchangeSlackCode(config(), transport(now), code, nonce);

  async function codeFor(nonce: string) {
    const url = slackLinkAuthorizeUrl(
      config(),
      { state: "state", nonce },
      null,
    );
    return (await idp.consent(url)).code;
  }

  test("returns the team and user of a verified id_token", async () => {
    const code = await codeFor("nonce-1");
    expect(await exchange(code, "nonce-1")).toEqual({
      ...account,
      teamName: null,
      userName: null,
    });
  });

  test("carries the team and display names the id_token gives", async () => {
    idp.setAccount({ ...account, teamName: "Acme", userName: " Alice " });
    try {
      const code = await codeFor("nonce-1");
      expect(await exchange(code, "nonce-1")).toEqual({
        ...account,
        teamName: "Acme",
        userName: "Alice",
      });
    } finally {
      idp.setAccount(account);
    }
  });

  test("a name longer than the API takes is left out", async () => {
    idp.setAccount({ ...account, teamName: "x".repeat(256), userName: "   " });
    try {
      const code = await codeFor("nonce-1");
      expect(await exchange(code, "nonce-1")).toEqual({
        ...account,
        teamName: null,
        userName: null,
      });
    } finally {
      idp.setAccount(account);
    }
  });

  test("a nonce from another attempt is rejected", async () => {
    const code = await codeFor("nonce-1");
    await expect(exchange(code, "nonce-2")).rejects.toThrow(
      new SlackOidcRejectedError("id_token did not verify: nonce_mismatch"),
    );
  });

  test("a code is good once", async () => {
    const code = await codeFor("nonce-1");
    await exchange(code, "nonce-1");
    await expect(exchange(code, "nonce-1")).rejects.toBeInstanceOf(
      SlackOidcRejectedError,
    );
  });

  async function codeFrom(other: MockSlackOidc): Promise<string> {
    const url = slackLinkAuthorizeUrl(
      { ...config(), issuer: other.listenUrl },
      { state: "s", nonce: "n" },
      null,
    );
    return (await other.consent(url)).code;
  }

  test("a token signed as another issuer is rejected", async () => {
    const other = await startMockSlackOidc({
      account,
      publicUrl: "https://impostor.example",
    });
    try {
      const code = await codeFrom(other);
      await expect(
        exchangeSlackCode(
          { ...config(), issuer: other.listenUrl },
          createSlackOidcTransport(other.listenUrl),
          code,
          "n",
        ),
      ).rejects.toThrow(/did not verify: issuer_mismatch/);
    } finally {
      await other.stop();
    }
  });

  test("a token issued to another client is rejected", async () => {
    const other = await startMockSlackOidc({
      account,
      audience: "someone-else",
    });
    try {
      const code = await codeFrom(other);
      await expect(
        exchangeSlackCode(
          { ...config(), issuer: other.url },
          createSlackOidcTransport(other.url),
          code,
          "n",
        ),
      ).rejects.toThrow(/did not verify: audience_mismatch/);
    } finally {
      await other.stop();
    }
  });

  // hono/jwt refused any iat ahead of this clock; the OIDC module allows the
  // same 60 seconds of skew as every sign-in provider, and no more.
  test("an iat up to a minute ahead of this clock is accepted", async () => {
    const code = await codeFor("nonce-1");
    expect(
      await exchange(code, "nonce-1", () => Date.now() - 30_000),
    ).toMatchObject(account);
  });

  test("an iat further ahead is rejected", async () => {
    const code = await codeFor("nonce-1");
    await expect(
      exchange(code, "nonce-1", () => Date.now() - 120_000),
    ).rejects.toThrow(/did not verify: issued_at_invalid/);
  });

  test("an unreachable Slack is unavailable, not a refusal", async () => {
    await expect(
      exchangeSlackCode(
        { ...config(), issuer: "http://127.0.0.1:9" },
        createSlackOidcTransport("http://127.0.0.1:9"),
        "c",
        "n",
      ),
    ).rejects.toBeInstanceOf(SlackOidcUnavailableError);
  });

  // Before, the request went out without a look at the address.
  test("Slack's name resolving to a metadata address is refused before anything is sent", async () => {
    const sent: string[] = [];
    const request = createProviderRequest({
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
      fetch: (async (target: URL) => {
        sent.push(String(target));
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await expect(
      exchangeSlackCode(
        { ...config(), issuer: "https://slack.com" },
        createSlackOidcTransport("https://slack.com", { request }),
        "c",
        "n",
      ),
    ).rejects.toThrow(
      new SlackOidcUnavailableError(
        "address_not_allowed: Provider resolves to a metadata address",
      ),
    );
    expect(sent).toEqual([]);
  });

  test("a mock issuer's own host passes; plain http anywhere else does not", async () => {
    await expect(
      createSlackOidcTransport(idp.url).postForm(
        "http://other.example/api/openid.connect.token",
        new URLSearchParams(),
      ),
    ).rejects.toThrow(/address_not_allowed/);
  });
});
