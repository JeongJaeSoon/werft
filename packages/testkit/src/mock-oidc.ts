import { createHash, randomBytes } from "node:crypto";

// A stand-in OIDC provider (Google's shape): discovery, JWKS, an authorize
// endpoint that consents at once and a token endpoint that checks the
// client, the redirect URI and PKCE. The account signing in is chosen by
// the caller through `login_hint`, base64url JSON of id_token claims, so a
// test can be any Google account — including one that lies (wrong aud,
// stale exp, unverified email) — without a browser.

export type MockOidcClaims = {
  sub: string;
  email: string;
  email_verified?: boolean | null;
  hd?: string;
  name?: string;
  // Anything else lands in the id_token as given and overrides the
  // defaults (iss, aud, exp, nonce): the negative cases. Null drops one.
  [claim: string]: unknown;
};

export type MockOidcServer = {
  issuer: string;
  port: number;
  /** Authorize and return the redirect URI's query, as a browser would. */
  authorize(
    authorizationUrl: string,
    claims: MockOidcClaims,
  ): Promise<{ code: string; state: string }>;
  stop(): void;
};

export function loginHint(claims: MockOidcClaims): string {
  return Buffer.from(JSON.stringify(claims)).toString("base64url");
}

type Grant = {
  claims: MockOidcClaims;
  nonce: string | null;
  challenge: string;
  redirectUri: string;
};

export async function startMockOidcServer(options: {
  clientId: string;
  clientSecret: string;
  hostname?: string;
  port?: number;
  /** Issuer the provider names itself; defaults to its own URL. */
  issuer?: string;
  /** Base URL the browser reaches /authorize on, when it differs. */
  publicUrl?: string;
}): Promise<MockOidcServer> {
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
  const kid = randomBytes(8).toString("hex");
  const encode = (part: unknown) =>
    Buffer.from(JSON.stringify(part)).toString("base64url");
  const sign = async (payload: Record<string, unknown>) => {
    const signed = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(payload)}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(signed),
    );
    return `${signed}.${Buffer.from(signature).toString("base64url")}`;
  };
  const publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  };
  const grants = new Map<string, Grant>();
  let issuer = options.issuer ?? "";
  let publicUrl = options.publicUrl ?? "";

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer,
          authorization_endpoint: `${publicUrl}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/jwks") {
        return Response.json({ keys: [publicJwk] });
      }
      if (url.pathname === "/authorize") {
        const query = url.searchParams;
        const redirectUri = query.get("redirect_uri");
        const hint = query.get("login_hint");
        if (
          query.get("client_id") !== options.clientId ||
          !redirectUri ||
          query.get("code_challenge_method") !== "S256" ||
          !query.get("code_challenge") ||
          !hint
        ) {
          return new Response("bad authorization request", { status: 400 });
        }
        const code = randomBytes(16).toString("base64url");
        grants.set(code, {
          claims: JSON.parse(Buffer.from(hint, "base64url").toString("utf8")),
          nonce: query.get("nonce"),
          challenge: query.get("code_challenge") as string,
          redirectUri,
        });
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", query.get("state") ?? "");
        return Response.redirect(target.toString(), 302);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const code = form.get("code") ?? "";
        const grant = grants.get(code);
        grants.delete(code);
        const verifier = form.get("code_verifier") ?? "";
        if (
          form.get("client_id") !== options.clientId ||
          form.get("client_secret") !== options.clientSecret ||
          !grant ||
          form.get("redirect_uri") !== grant.redirectUri ||
          createHash("sha256").update(verifier).digest("base64url") !==
            grant.challenge
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const now = Math.floor(Date.now() / 1000);
        const payload: Record<string, unknown> = {
          iss: issuer,
          aud: options.clientId,
          iat: now,
          exp: now + 600,
          email_verified: true,
          ...(grant.nonce ? { nonce: grant.nonce } : {}),
          ...grant.claims,
        };
        for (const [claim, value] of Object.entries(payload)) {
          if (value === null) delete payload[claim];
        }
        const idToken = await sign(payload);
        return Response.json({
          access_token: randomBytes(16).toString("base64url"),
          token_type: "Bearer",
          expires_in: 600,
          id_token: idToken,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const own = `http://${server.hostname}:${server.port}`;
  issuer ||= own;
  publicUrl ||= own;

  return {
    issuer,
    port: server.port as number,
    async authorize(authorizationUrl, claims) {
      const target = new URL(authorizationUrl);
      target.searchParams.set("login_hint", loginHint(claims));
      const response = await fetch(`${own}${target.pathname}${target.search}`, {
        redirect: "manual",
      });
      const location = response.headers.get("Location");
      if (response.status !== 302 || !location) {
        throw new Error(`mock authorize answered ${response.status}`);
      }
      const back = new URL(location).searchParams;
      return { code: back.get("code") ?? "", state: back.get("state") ?? "" };
    },
    stop() {
      server.stop(true);
    },
  };
}
