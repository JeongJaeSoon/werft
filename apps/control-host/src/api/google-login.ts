import { createHash, randomBytes } from "node:crypto";
import {
  GOOGLE_LOGIN_FLOW_TTL_MINUTES,
  normalizeEmail,
} from "@werft-ai/contracts";
import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { providerFetch } from "./provider-fetch.ts";
import { sameString } from "./same-string.ts";

export const GOOGLE_ISSUER = "https://accounts.google.com";
const FLOW_TTL_MS = GOOGLE_LOGIN_FLOW_TTL_MINUTES * 60 * 1000;

export type GoogleLoginConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  issuer: string;
  /** Lower-cased; empty means any Google account may try. */
  allowedDomains: readonly string[];
  /** Whether an allowed domain joins as a member with no invite. */
  jit: boolean;
};

const ENV = {
  clientId: "GOOGLE_OIDC_CLIENT_ID",
  clientSecret: "GOOGLE_OIDC_CLIENT_SECRET",
  redirectUri: "GOOGLE_OIDC_REDIRECT_URI",
  issuer: "GOOGLE_OIDC_ISSUER",
  allowedDomains: "GOOGLE_OIDC_ALLOWED_DOMAINS",
  jit: "GOOGLE_OIDC_JIT",
} as const;

/**
 * Null when Google sign-in is not configured at all. Half a configuration,
 * or JIT with no domain list (any Google account would join), is a problem
 * the process refuses to start with.
 */
export function googleLoginConfigFromEnv(
  environment: Record<string, string | undefined>,
): { config: GoogleLoginConfig | null; problems: string[] } {
  const read = (name: string) => environment[name]?.trim() || undefined;
  const clientId = read(ENV.clientId);
  const clientSecret = read(ENV.clientSecret);
  const redirectUri = read(ENV.redirectUri);
  const required = [clientId, clientSecret, redirectUri];
  const problems: string[] = [];
  if (required.every((value) => value === undefined)) {
    const stray = [ENV.issuer, ENV.allowedDomains, ENV.jit].filter(
      (name) => read(name) !== undefined,
    );
    if (stray.length > 0) {
      problems.push(
        `${stray.join(", ")} set without ${ENV.clientId}, ${ENV.clientSecret} and ${ENV.redirectUri}`,
      );
    }
    return { config: null, problems };
  }
  for (const name of [ENV.clientId, ENV.clientSecret, ENV.redirectUri]) {
    if (read(name) === undefined) problems.push(`${name} is required`);
  }
  const issuer = read(ENV.issuer) ?? GOOGLE_ISSUER;
  for (const [name, value] of [
    [ENV.redirectUri, redirectUri],
    [ENV.issuer, issuer],
  ] as const) {
    if (value !== undefined && !URL.canParse(value)) {
      problems.push(`${name} must be an absolute URL`);
    }
  }
  const allowedDomains = (read(ENV.allowedDomains) ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
  const jitValue = read(ENV.jit) ?? "off";
  if (jitValue !== "off" && jitValue !== "member") {
    problems.push(`${ENV.jit} must be off or member`);
  }
  const jit = jitValue === "member";
  if (jit && allowedDomains.length === 0) {
    problems.push(`${ENV.jit}=member requires ${ENV.allowedDomains}`);
  }
  if (problems.length > 0 || !clientId || !clientSecret || !redirectUri) {
    return { config: null, problems };
  }
  return {
    config: {
      clientId,
      clientSecret,
      redirectUri,
      issuer,
      allowedDomains,
      jit,
    },
    problems,
  };
}

/** The provider could not be reached or answered 5xx; worth a retry. */
export class GoogleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleUnavailableError";
  }
}

/** The flow or the provider's answer does not prove who is signing in. */
export class GoogleLoginInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleLoginInvalidError";
  }
}

export type GoogleIdentity = {
  issuer: string;
  subject: string;
  /** Normalized; the provider said it is verified. */
  email: string;
  /** Google Workspace domain (`hd`); absent for a consumer account. */
  hostedDomain: string | null;
  name: string | null;
};

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

export type GoogleFlow = {
  authorizationUrl: string;
  /** Goes into the flow cookie; never logged. */
  cookieValue: string;
};

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function googleFetch(url: string, init?: RequestInit): Promise<Response> {
  return providerFetch(url, init, {
    unreachable: (error) =>
      new GoogleUnavailableError(
        `Google sign-in provider unreachable: ${error instanceof Error ? error.name : "error"}`,
      ),
    answered: (status) =>
      new GoogleUnavailableError(`Google sign-in provider answered ${status}`),
  });
}

export interface GoogleLogin {
  readonly config: GoogleLoginConfig;
  start(): Promise<GoogleFlow>;
  /** Throws GoogleLoginInvalidError or GoogleUnavailableError. */
  finish(input: {
    cookieValue: string | undefined;
    code: string;
    state: string;
  }): Promise<GoogleIdentity>;
}

export function createGoogleLogin(
  config: GoogleLoginConfig,
  now: () => number = Date.now,
): GoogleLogin {
  let discovery: Promise<Discovery> | undefined;
  const discover = () => {
    discovery ??= (async () => {
      const response = await googleFetch(
        `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      );
      if (!response.ok) {
        throw new GoogleUnavailableError(
          `OIDC discovery answered ${response.status}`,
        );
      }
      const body = (await response.json()) as Partial<Discovery>;
      if (
        body.issuer !== config.issuer ||
        typeof body.authorization_endpoint !== "string" ||
        typeof body.token_endpoint !== "string" ||
        typeof body.jwks_uri !== "string"
      ) {
        throw new GoogleUnavailableError("OIDC discovery document is invalid");
      }
      return body as Discovery;
    })();
    discovery.catch(() => {
      discovery = undefined;
    });
    return discovery;
  };
  // Google's id_token names its issuer with or without the scheme.
  const issuers =
    config.issuer === GOOGLE_ISSUER
      ? [GOOGLE_ISSUER, "accounts.google.com"]
      : [config.issuer];

  return {
    config,
    async start() {
      const endpoints = await discover();
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken();
      const url = new URL(endpoints.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        // Lets Google preselect the account; the domain is still enforced
        // on the id_token, never trusted from here.
        ...(config.allowedDomains.length === 1
          ? { hd: config.allowedDomains[0] as string }
          : {}),
      }).toString();
      return {
        authorizationUrl: url.toString(),
        cookieValue: [state, nonce, verifier, String(now())].join("."),
      };
    },

    async finish({ cookieValue, code, state }) {
      const [expectedState, nonce, verifier, startedAt] = (
        cookieValue ?? ""
      ).split(".");
      if (
        !expectedState ||
        !nonce ||
        !verifier ||
        !startedAt ||
        !sameString(state, expectedState)
      ) {
        throw new GoogleLoginInvalidError("Sign-in flow state does not match");
      }
      if (now() - Number(startedAt) > FLOW_TTL_MS) {
        throw new GoogleLoginInvalidError("Sign-in flow expired");
      }
      const endpoints = await discover();
      const tokenResponse = await googleFetch(endpoints.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code_verifier: verifier,
        }),
      });
      if (!tokenResponse.ok) {
        throw new GoogleLoginInvalidError(
          `Token endpoint refused the code (${tokenResponse.status})`,
        );
      }
      const { id_token: idToken } = (await tokenResponse.json()) as {
        id_token?: unknown;
      };
      if (typeof idToken !== "string") {
        throw new GoogleLoginInvalidError("Token response has no id_token");
      }
      const jwksResponse = await googleFetch(endpoints.jwks_uri);
      if (!jwksResponse.ok) {
        throw new GoogleUnavailableError(
          `JWKS answered ${jwksResponse.status}`,
        );
      }
      const { keys } = (await jwksResponse.json()) as {
        keys?: HonoJsonWebKey[];
      };
      let claims: Record<string, unknown>;
      try {
        claims = await Jwt.verifyWithJwks(idToken, {
          keys: Array.isArray(keys) ? keys : [],
          allowedAlgorithms: ["RS256"],
          verification: { aud: config.clientId },
        });
      } catch (error) {
        throw new GoogleLoginInvalidError(
          `id_token rejected: ${error instanceof Error ? error.name : "error"}`,
        );
      }
      // hono checks exp only when present, and iss only against one value.
      if (
        typeof claims.exp !== "number" ||
        typeof claims.iss !== "string" ||
        !issuers.includes(claims.iss)
      ) {
        throw new GoogleLoginInvalidError("id_token iss or exp is invalid");
      }
      if (
        typeof claims.nonce !== "string" ||
        !sameString(claims.nonce, nonce)
      ) {
        throw new GoogleLoginInvalidError("id_token nonce does not match");
      }
      if (claims.azp !== undefined && claims.azp !== config.clientId) {
        throw new GoogleLoginInvalidError("id_token azp is another client");
      }
      if (
        typeof claims.sub !== "string" ||
        claims.sub.length === 0 ||
        typeof claims.email !== "string" ||
        claims.email_verified !== true
      ) {
        throw new GoogleLoginInvalidError(
          "id_token has no subject or verified email",
        );
      }
      return {
        issuer: config.issuer,
        subject: claims.sub,
        email: normalizeEmail(claims.email),
        hostedDomain:
          typeof claims.hd === "string" ? claims.hd.toLowerCase() : null,
        name: typeof claims.name === "string" ? claims.name : null,
      };
    },
  };
}

/**
 * Null when a domain restriction keeps the account out. Otherwise whether
 * Google vouches the person owns the address today, and the role JIT may
 * give, which only an account inside the allowed domains gets.
 */
export function domainAdmission(
  config: GoogleLoginConfig,
  identity: GoogleIdentity,
): { jitRole: "member" | null; ownsEmail: boolean } | null {
  const emailDomain = identity.email.slice(identity.email.lastIndexOf("@") + 1);
  // Google is authoritative for an address only on gmail.com or when the
  // account's own Workspace domain (`hd`) is the address's domain; any other
  // address was verified once, at sign-up, and may since belong to someone
  // else.
  const hostedAddress = identity.hostedDomain === emailDomain;
  const ownsEmail = hostedAddress || emailDomain === "gmail.com";
  if (config.allowedDomains.length === 0) {
    return { jitRole: null, ownsEmail };
  }
  const inside =
    hostedAddress &&
    identity.hostedDomain !== null &&
    config.allowedDomains.includes(identity.hostedDomain);
  if (!inside) return null;
  return { jitRole: config.jit ? "member" : null, ownsEmail };
}
