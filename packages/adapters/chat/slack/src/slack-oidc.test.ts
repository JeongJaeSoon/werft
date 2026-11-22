import { describe, expect, test } from "bun:test";
import { SLACK_LINK_USER_SCOPES } from "./slack-manifest.ts";
import {
  exchangeSlackCode,
  SlackOidcRejectedError,
  type SlackOidcTransport,
  slackLinkAuthorizeUrl,
} from "./slack-oidc.ts";

const config = {
  clientId: "1000.1",
  clientSecret: "client-secret-value",
  redirectUri: "https://werft.example/settings/linked-accounts/slack",
  issuer: "https://slack.com",
};

function transport(
  answer: { status: number; text: string },
  claims: Record<string, unknown> = {},
) {
  const calls: unknown[] = [];
  const fake: SlackOidcTransport = {
    postForm: async (url, form) => {
      calls.push({ url, form: Object.fromEntries(form) });
      return answer;
    },
    verifyIdToken: async (idToken, expected) => {
      calls.push({ idToken, expected });
      return claims;
    },
  };
  return { fake, calls };
}

describe("slackLinkAuthorizeUrl", () => {
  test("asks for the link app's user scopes, and the team when one is known", () => {
    const url = new URL(
      slackLinkAuthorizeUrl(config, { state: "s", nonce: "n" }, "T0TEAM"),
    );
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/openid/connect/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      scope: SLACK_LINK_USER_SCOPES.join(" "),
      client_id: "1000.1",
      redirect_uri: config.redirectUri,
      state: "s",
      nonce: "n",
      team: "T0TEAM",
    });
    expect(url.searchParams.get("scope")).toBe("openid profile");
  });
});

describe("exchangeSlackCode", () => {
  const ok = { status: 200, text: JSON.stringify({ ok: true, id_token: "t" }) };

  test("sends the code, then has the id_token verified against Slack's keys", async () => {
    const { fake, calls } = transport(ok, {
      "https://slack.com/team_id": "T0TEAM",
      "https://slack.com/user_id": "U0USER",
      sub: "U0OTHER",
    });
    expect(await exchangeSlackCode(config, fake, "code-1", "nonce-1")).toEqual({
      teamId: "T0TEAM",
      userId: "U0USER",
      teamName: null,
      userName: null,
    });
    expect(calls).toEqual([
      {
        url: "https://slack.com/api/openid.connect.token",
        form: {
          grant_type: "authorization_code",
          client_id: "1000.1",
          client_secret: "client-secret-value",
          code: "code-1",
          redirect_uri: config.redirectUri,
        },
      },
      {
        idToken: "t",
        expected: {
          jwksUri: "https://slack.com/openid/connect/keys",
          issuer: "https://slack.com",
          clientId: "1000.1",
          nonce: "nonce-1",
        },
      },
    ]);
  });

  test("sub stands in for a missing Slack user id", async () => {
    const { fake } = transport(ok, {
      "https://slack.com/team_id": "T0TEAM",
      sub: "U0SUB",
    });
    expect(await exchangeSlackCode(config, fake, "c", "n")).toMatchObject({
      userId: "U0SUB",
    });
  });

  test.each([
    ["ok:false", { status: 200, text: '{"ok":false,"error":"invalid_code"}' }],
    ["no id_token", { status: 200, text: '{"ok":true}' }],
    ["not JSON", { status: 400, text: "<html>" }],
  ])("a token answer with %s is a refusal", async (_, answer) => {
    const { fake, calls } = transport(answer);
    await expect(
      exchangeSlackCode(config, fake, "c", "n"),
    ).rejects.toBeInstanceOf(SlackOidcRejectedError);
    expect(calls).toHaveLength(1);
  });

  test("an id_token naming no Slack team is a refusal", async () => {
    const { fake } = transport(ok, { sub: "U0USER" });
    await expect(exchangeSlackCode(config, fake, "c", "n")).rejects.toThrow(
      "id_token names no Slack team or user",
    );
  });
});
