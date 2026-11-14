import { randomBytes } from "node:crypto";
import type { FakeSlackWebApi } from "./fake-slack-api.ts";

// A stand-in for Sign in with Slack: the three endpoints the platform calls
// (authorize, openid.connect.token, keys), with id_tokens signed by a key
// made at start. Consent is automatic; which Slack account comes back is
// the configured one, or `mock_team`/`mock_user` on the authorize URL, and
// `mock_team_name`/`mock_user_name` replace its names.
// It also answers the Web API calls the slack-install CLI makes
// (`/api/auth.test`, `/api/bots.info`) for one bot in the configured team.

export type MockSlackAccount = {
  teamId: string;
  userId: string;
  /** Sent as `https://slack.com/team_name` and `name` when set. */
  teamName?: string | undefined;
  userName?: string | undefined;
};

export type MockSlackOidc = {
  /** The issuer: what MOCK_SLACK_OIDC_ISSUER is set to. */
  url: string;
  /** Where it listens, when that differs from the issuer it signs as. */
  listenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Which account the next consent returns. */
  setAccount(account: MockSlackAccount): void;
  /** Follows the authorize URL as a browser would; returns the callback query. */
  consent(authorizeUrl: string): Promise<{ code: string; state: string }>;
  stop(): Promise<void>;
};

/** The bot `auth.test` and `bots.info` answer for, when the token matches. */
export type MockSlackBot = {
  token: string;
  appId: string;
  botId: string;
  botUserId: string;
};

type PendingCode = {
  clientId: string;
  redirectUri: string;
  nonce: string;
  account: MockSlackAccount;
};

const KEY_ID = "mock-slack-1";

function base64url(bytes: ArrayBuffer | Uint8Array | string): string {
  return Buffer.from(
    typeof bytes === "string" ? bytes : new Uint8Array(bytes),
  ).toString("base64url");
}

export async function startMockSlackOidc(
  options: {
    hostname?: string;
    port?: number;
    /** What the issuer URL says, when the listener is reached by another name. */
    publicUrl?: string;
    clientId?: string;
    clientSecret?: string;
    account?: MockSlackAccount;
    bot?: Partial<MockSlackBot>;
    /** Signs tokens for this audience instead of the client: a forged token. */
    audience?: string;
    /** Slack's Web API fake, served on the same port ahead of the bot above. */
    webApi?: FakeSlackWebApi;
  } = {},
): Promise<MockSlackOidc> {
  const clientId = options.clientId ?? "mock-client-id";
  const clientSecret = options.clientSecret ?? "mock-client-secret";
  let account = options.account ?? { teamId: "T0MOCK", userId: "U0MOCK" };
  const bot: MockSlackBot = {
    token: "mock-bot-token",
    appId: "A0MOCK",
    botId: "B0MOCK",
    botUserId: "U0MOCKBOT",
    ...options.bot,
  };
  const codes = new Map<string, PendingCode>();
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: KEY_ID,
    alg: "RS256",
    use: "sig",
  };
  let issuer = "";

  /**
   * The fixed client, or one the Web API fake made with
   * `apps.manifest.create` (a workspace's link app); with `secret`, only
   * when it is that client's.
   */
  function knownClient(id: string, secret?: string): boolean {
    if (id === clientId) return secret === undefined || secret === clientSecret;
    const app = [...(options.webApi?.apps.values() ?? [])].find(
      (candidate) => candidate.clientId === id,
    );
    return (
      app !== undefined && (secret === undefined || secret === app.clientSecret)
    );
  }

  async function idToken(pending: PendingCode): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: KEY_ID }),
    );
    const payload = base64url(
      JSON.stringify({
        iss: issuer,
        aud: options.audience ?? pending.clientId,
        sub: pending.account.userId,
        iat: now,
        exp: now + 300,
        nonce: pending.nonce,
        "https://slack.com/user_id": pending.account.userId,
        "https://slack.com/team_id": pending.account.teamId,
        "https://slack.com/team_name": pending.account.teamName,
        name: pending.account.userName,
      }),
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64url(signature)}`;
  }

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok");
      const answered = await options.webApi?.handle(request.clone());
      if (answered) return answered;
      if (
        url.pathname === "/api/auth.test" ||
        url.pathname === "/api/bots.info"
      ) {
        // Slack answers HTTP 200 with ok:false for a bad token.
        if (request.headers.get("authorization") !== `Bearer ${bot.token}`) {
          return Response.json({ ok: false, error: "invalid_auth" });
        }
        if (url.pathname === "/api/auth.test") {
          return Response.json({
            ok: true,
            url: "https://mock.slack.test/",
            team: "mock",
            user: "mock-bot",
            team_id: account.teamId,
            user_id: bot.botUserId,
            bot_id: bot.botId,
            is_enterprise_install: false,
          });
        }
        const form = new URLSearchParams(await request.text());
        if ((form.get("bot") ?? url.searchParams.get("bot")) !== bot.botId) {
          return Response.json({ ok: false, error: "bot_not_found" });
        }
        return Response.json({
          ok: true,
          bot: {
            id: bot.botId,
            deleted: false,
            name: "mock-bot",
            app_id: bot.appId,
            user_id: bot.botUserId,
          },
        });
      }
      if (url.pathname === "/openid/connect/keys") {
        return Response.json({ keys: [publicJwk] });
      }
      if (url.pathname === "/openid/connect/authorize") {
        const query = url.searchParams;
        const redirectUri = query.get("redirect_uri");
        const state = query.get("state");
        const nonce = query.get("nonce");
        const client = query.get("client_id");
        if (
          client === null ||
          !knownClient(client) ||
          query.get("response_type") !== "code" ||
          !redirectUri ||
          !state ||
          !nonce
        ) {
          return new Response("invalid authorize request", { status: 400 });
        }
        const code = base64url(randomBytes(24));
        codes.set(code, {
          clientId: client,
          redirectUri,
          nonce,
          account: {
            ...account,
            teamId: query.get("mock_team") ?? account.teamId,
            userId: query.get("mock_user") ?? account.userId,
            // Empty sends an empty claim, which the platform treats as none.
            teamName: query.get("mock_team_name") ?? account.teamName,
            userName: query.get("mock_user_name") ?? account.userName,
          },
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", state);
        return Response.redirect(back.toString(), 302);
      }
      if (
        url.pathname === "/api/openid.connect.token" &&
        request.method === "POST"
      ) {
        const form = new URLSearchParams(await request.text());
        const code = form.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        if (
          !knownClient(
            form.get("client_id") ?? "",
            form.get("client_secret") ?? "",
          ) ||
          (pending !== undefined && pending.clientId !== form.get("client_id"))
        ) {
          return Response.json({ ok: false, error: "invalid_client" });
        }
        if (!pending || form.get("redirect_uri") !== pending.redirectUri) {
          return Response.json({ ok: false, error: "invalid_code" });
        }
        return Response.json({
          ok: true,
          access_token: "mock-access-token",
          token_type: "Bearer",
          id_token: await idToken(pending),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  issuer = (options.publicUrl ?? `http://127.0.0.1:${server.port}`).replace(
    /\/+$/,
    "",
  );
  const listening = `http://127.0.0.1:${server.port}`;

  return {
    url: issuer,
    listenUrl: listening,
    clientId,
    clientSecret,
    setAccount(next) {
      account = next;
    },
    async consent(authorizeUrl) {
      const target = new URL(authorizeUrl);
      const response = await fetch(
        `${listening}${target.pathname}${target.search}`,
        { redirect: "manual" },
      );
      const location = response.headers.get("location");
      if (response.status !== 302 || !location) {
        throw new Error(`mock consent failed: ${response.status}`);
      }
      const back = new URL(location).searchParams;
      return { code: back.get("code") ?? "", state: back.get("state") ?? "" };
    },
    async stop() {
      await server.stop(true);
    },
  };
}
