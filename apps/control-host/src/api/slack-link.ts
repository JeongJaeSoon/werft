import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  SlackOidcRejectedError,
  type SlackOidcTransport,
  SlackOidcUnavailableError,
} from "../wiring/chat-slack.ts";
import {
  fetchJwks,
  hostPortOf,
  type NetworkPolicy,
  OidcRejectedError,
  OidcUnavailableError,
  type ProviderRequest,
  providerRequest,
  verifyIdToken,
} from "./oidc/index.ts";
import { sameString as sameToken } from "./same-string.ts";
import { SLACK_ISSUER } from "./slack-config.ts";

// The console side of Sign in with Slack: whether it is on, the one-time
// state the browser holds, and the OIDC client the Slack adapter's code
// exchange runs on.

export function signInWithSlackOff(
  consoleOrigin: string | null,
  storeOn: boolean,
): string | null {
  if (consoleOrigin === null) {
    return "Sign in with Slack is off (CONSOLE_ORIGIN unset); Slack accounts cannot be linked";
  }
  if (!storeOn) {
    return "Sign in with Slack is off: no link app can be made without PLATFORM_SECRET_KEY";
  }
  return null;
}

// ---------------------------------------------------------------------------
// One-time state, held by the browser
// ---------------------------------------------------------------------------

export const SLACK_LINK_COOKIE_NAME = "werft_slack_link";
const SLACK_LINK_COOKIE_PATH = "/v1/linked-accounts/slack";
export const SLACK_LINK_TTL_MS = 10 * 60 * 1000;

export type SlackLinkState = { state: string; nonce: string; userId: string };

function token(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * State and nonce live in an HttpOnly cookie scoped to the callback, bound
 * to the person who started: a callback carrying someone else's code, or
 * replayed from another browser, finds no matching cookie.
 */
export function issueSlackLinkState(
  context: Context,
  userId: string,
  expiresAt: Date,
): SlackLinkState {
  const issued = { state: token(), nonce: token(), userId };
  setCookie(
    context,
    SLACK_LINK_COOKIE_NAME,
    `${issued.state}.${issued.nonce}.${userId}`,
    {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: SLACK_LINK_COOKIE_PATH,
      expires: expiresAt,
    },
  );
  return issued;
}

/** Spends the cookie whatever the outcome; null unless it matches. */
export function consumeSlackLinkState(
  context: Context,
  state: string,
  userId: string,
): SlackLinkState | null {
  const raw = getCookie(context, SLACK_LINK_COOKIE_NAME);
  deleteCookie(context, SLACK_LINK_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: SLACK_LINK_COOKIE_PATH,
  });
  const [cookieState, nonce, cookieUser, ...rest] = raw?.split(".") ?? [];
  if (!cookieState || !nonce || !cookieUser || rest.length > 0) return null;
  if (!sameToken(cookieState, state) || cookieUser !== userId) return null;
  return { state: cookieState, nonce, userId: cookieUser };
}

// ---------------------------------------------------------------------------
// The OIDC client
// ---------------------------------------------------------------------------

/**
 * Slack is https on the public internet. A mock IdP (MOCK_SLACK_OIDC_ISSUER)
 * is the one host that may be plain http on a private or loopback address.
 */
export function slackNetworkPolicy(issuer: string): NetworkPolicy {
  return issuer === SLACK_ISSUER
    ? { plainHttp: "refuse" }
    : { plainHttp: "refuse", privateHosts: [hostPortOf(new URL(issuer))] };
}

async function asSlackError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OidcRejectedError) {
      throw new SlackOidcRejectedError(
        `id_token did not verify: ${error.reason}`,
      );
    }
    if (error instanceof OidcUnavailableError) {
      throw new SlackOidcUnavailableError(`${error.kind}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * The platform's OIDC client for one issuer: every request under its network
 * policy, the id_token held to the same checks as any sign-in provider's.
 */
export function createSlackOidcTransport(
  issuer: string,
  deps: { request?: ProviderRequest; now?: () => number } = {},
): SlackOidcTransport {
  const policy = slackNetworkPolicy(issuer);
  const request = deps.request ?? providerRequest;
  const now = deps.now ?? Date.now;
  return {
    postForm: (url, form) =>
      asSlackError(() =>
        request(
          url,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
          },
          policy,
        ),
      ),
    verifyIdToken: (idToken, expected) =>
      asSlackError(async () =>
        verifyIdToken(idToken, {
          keys: await fetchJwks(expected.jwksUri, policy, request),
          algs: ["RS256"],
          issuers: [expected.issuer],
          clientId: expected.clientId,
          nonce: expected.nonce,
          now,
        }),
      ),
  };
}
