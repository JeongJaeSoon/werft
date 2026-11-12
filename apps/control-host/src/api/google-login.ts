import { GOOGLE_LOGIN_FLOW_TTL_MINUTES } from "@werft-ai/contracts";
import {
  authorizationParams,
  discover,
  finishFlow,
  GOOGLE_ISSUER,
  type NetworkPolicy,
  type OidcClient,
  OidcDiscoveryError,
  type OidcEndpoints,
  OidcRejectedError,
  OidcUnavailableError,
  startFlow,
  tokenIssuers,
} from "./oidc/index.ts";
import { sameString } from "./same-string.ts";

export { GOOGLE_ISSUER };
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

export type GoogleFlow = {
  authorizationUrl: string;
  /** Goes into the flow cookie; never logged. */
  cookieValue: string;
};

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

async function asGoogleError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OidcRejectedError) {
      throw new GoogleLoginInvalidError(error.message);
    }
    if (error instanceof OidcUnavailableError) {
      throw new GoogleUnavailableError(
        `Google sign-in provider unavailable: ${error.message}`,
      );
    }
    if (error instanceof OidcDiscoveryError) {
      throw new GoogleUnavailableError(
        `OIDC discovery document is invalid: ${error.problem}`,
      );
    }
    throw error;
  }
}

export function createGoogleLogin(
  config: GoogleLoginConfig,
  now: () => number = Date.now,
): GoogleLogin {
  // The operator named this issuer in the process environment, and a local
  // stack names a plain-http stand-in there. Providers stored as settings
  // get the stricter loopback-only rule instead.
  const policy: NetworkPolicy = {
    plainHttp: config.issuer.startsWith("http://") ? "any" : "refuse",
  };
  // Google takes the client secret in the form body, as this always sent it.
  const client: OidcClient = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenAuthMethod: "client_secret_post",
    redirectUri: config.redirectUri,
  };
  let discovery: Promise<OidcEndpoints> | undefined;
  // Kept for the life of the process; a failed read is tried again.
  const loadEndpoints = () => {
    discovery ??= discover(config.issuer, policy);
    discovery.catch(() => {
      discovery = undefined;
    });
    return discovery;
  };

  return {
    config,
    start: () =>
      asGoogleError(async () => {
        const flow = startFlow({
          endpoints: await loadEndpoints(),
          client,
          extraParams: authorizationParams(
            GOOGLE_ISSUER,
            config.allowedDomains,
          ),
        });
        return {
          authorizationUrl: flow.authorizationUrl,
          cookieValue: [
            flow.state,
            flow.nonce,
            flow.verifier,
            String(now()),
          ].join("."),
        };
      }),

    finish: ({ cookieValue, code, state }) =>
      asGoogleError(async () => {
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
          throw new GoogleLoginInvalidError(
            "Sign-in flow state does not match",
          );
        }
        if (now() - Number(startedAt) > FLOW_TTL_MS) {
          throw new GoogleLoginInvalidError("Sign-in flow expired");
        }
        const identity = await finishFlow({
          // This callback does not carry the authorization response's `iss`.
          endpoints: {
            ...(await loadEndpoints()),
            issParameterRequired: false,
          },
          client,
          issuers: tokenIssuers(config.issuer),
          code,
          nonce,
          verifier,
          requireVerifiedEmail: true,
          policy,
          now: now(),
        });
        return {
          issuer: identity.issuer,
          subject: identity.subject,
          // requireVerifiedEmail leaves no sign-in without an address.
          email: identity.email as string,
          hostedDomain:
            typeof identity.claims.hd === "string"
              ? identity.claims.hd.toLowerCase()
              : null,
          name: identity.name,
        };
      }),
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
