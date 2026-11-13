import { createHash, randomBytes } from "node:crypto";

// A stand-in OIDC provider (Google's shape): discovery, JWKS, an authorize
// endpoint that consents at once and a token endpoint that checks the
// client, the redirect URI and PKCE. The account signing in is chosen by
// the caller through `login_hint`, base64url JSON of id_token claims, so a
// test can be any Google account — including one that lies (wrong aud,
// stale exp, unverified email) — without a browser. Options give it another
// provider's shape: an issuer under a path, ES256, a thin id_token with
// UserInfo, a discovery document with a real provider's lists, and no PKCE
// check.

export type MockOidcClaims = {
  sub: string;
  email: string | null;
  email_verified?: boolean | null;
  hd?: string | null;
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
  ): Promise<{ code: string; state: string; iss?: string }>;
  /** Signs with a new key from now on and publishes only that one. */
  rotateKeys(): Promise<void>;
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
  /** What id_tokens are signed with; RS256 unless given. */
  signingAlg?: "RS256" | "ES256";
  /**
   * The id_token carries no `email`, `email_verified` or `name`, and
   * discovery names the UserInfo endpoint that serves them. UserInfo
   * answers at `/userinfo` either way.
   */
  thinIdToken?: boolean;
  /**
   * False for a provider that ignores `code_verifier` when the client
   * authenticates with a secret.
   */
  checksPkce?: boolean;
  /** The one way the client may name itself; either way unless given. */
  clientAuth?: "client_secret_basic" | "client_secret_post";
  /**
   * Laid over the discovery document, to list what a real provider lists;
   * null drops a field. With
   * `authorization_response_iss_parameter_supported: true` the redirect
   * back carries `iss`.
   */
  discovery?: Record<string, unknown>;
}): Promise<MockOidcServer> {
  const alg = options.signingAlg ?? "RS256";
  const algorithm =
    alg === "ES256"
      ? { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }
      : {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        };
  /** A fresh signing key under a fresh `kid`. */
  const newKey = async () => {
    const pair = (await crypto.subtle.generateKey(algorithm, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const kid = randomBytes(8).toString("hex");
    return {
      kid,
      privateKey: pair.privateKey,
      publicJwk: {
        ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
        kid,
        alg,
        use: "sig",
      },
    };
  };
  let key = await newKey();
  const encode = (part: unknown) =>
    Buffer.from(JSON.stringify(part)).toString("base64url");
  const sign = async (payload: Record<string, unknown>) => {
    const signed = `${encode({ alg, typ: "JWT", kid: key.kid })}.${encode(payload)}`;
    // For ES256 WebCrypto already answers the r||s a JWS carries.
    const signature = await crypto.subtle.sign(
      algorithm,
      key.privateKey,
      new TextEncoder().encode(signed),
    );
    return `${signed}.${Buffer.from(signature).toString("base64url")}`;
  };
  const grants = new Map<string, Grant>();
  /** What UserInfo answers, by the access token it was issued with. */
  const userinfo = new Map<string, Record<string, unknown>>();
  const base = options.issuer
    ? new URL(options.issuer).pathname.replace(/\/$/, "")
    : "";
  const sendsIssuer =
    options.discovery?.authorization_response_iss_parameter_supported === true;
  let issuer = options.issuer ?? "";
  let publicUrl = options.publicUrl ?? "";

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok");
      // The endpoints live under the issuer's path, as a tenant's or a
      // realm's do.
      if (!url.pathname.startsWith(`${base}/`)) {
        return new Response("not found", { status: 404 });
      }
      const route = url.pathname.slice(base.length);
      if (route === "/.well-known/openid-configuration") {
        const document = {
          issuer,
          authorization_endpoint: `${publicUrl}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          ...(options.thinIdToken
            ? { userinfo_endpoint: `${issuer}/userinfo` }
            : {}),
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: [alg],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
          ...options.discovery,
        };
        return Response.json(
          Object.fromEntries(
            Object.entries(document).filter(([, value]) => value !== null),
          ),
        );
      }
      if (route === "/userinfo") {
        const bearer = request.headers
          .get("Authorization")
          ?.match(/^Bearer (.+)$/)?.[1];
        const served = bearer ? userinfo.get(bearer) : undefined;
        return served
          ? Response.json(served)
          : new Response("unauthorized", { status: 401 });
      }
      if (route === "/jwks") {
        return Response.json({ keys: [key.publicJwk] });
      }
      if (route === "/authorize") {
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
        if (sendsIssuer) target.searchParams.set("iss", issuer);
        return Response.redirect(target.toString(), 302);
      }
      if (route === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const code = form.get("code") ?? "";
        const grant = grants.get(code);
        grants.delete(code);
        const verifier = form.get("code_verifier") ?? "";
        // The client names itself in the body or, form-encoded half by
        // half, in a Basic header (RFC 6749 2.3.1).
        const basic = request.headers
          .get("Authorization")
          ?.match(/^Basic (.+)$/)?.[1];
        const [clientId, clientProof] = basic
          ? Buffer.from(basic, "base64")
              .toString("utf8")
              .split(":")
              .map((half) => new URLSearchParams(`v=${half}`).get("v"))
          : [form.get("client_id"), form.get("client_secret")];
        if (
          (options.clientAuth !== undefined &&
            (options.clientAuth === "client_secret_basic") !==
              (basic !== undefined)) ||
          clientId !== options.clientId ||
          clientProof !== options.clientSecret ||
          !grant ||
          form.get("redirect_uri") !== grant.redirectUri ||
          (options.checksPkce !== false &&
            createHash("sha256").update(verifier).digest("base64url") !==
              grant.challenge)
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
        const bearer = randomBytes(16).toString("base64url");
        // UserInfo answers the scope's claims about the same subject; a thin
        // id_token leaves them to it.
        const served: Record<string, unknown> = { sub: payload.sub };
        for (const claim of ["email", "email_verified", "name"]) {
          if (claim in payload) served[claim] = payload[claim];
          if (options.thinIdToken) delete payload[claim];
        }
        userinfo.set(bearer, served);
        const idToken = await sign(payload);
        return Response.json({
          access_token: bearer,
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
  publicUrl ||= `${own}${base}`;

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
      const iss = back.get("iss");
      return {
        code: back.get("code") ?? "",
        state: back.get("state") ?? "",
        ...(iss === null ? {} : { iss }),
      };
    },
    async rotateKeys() {
      key = await newKey();
    },
    stop() {
      server.stop(true);
    },
  };
}
