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
import { SLACK_ISSUER } from "./slack-config.ts";

// The console side of Sign in with Slack: whether it is on, and the OIDC
// client the Slack adapter's code exchange runs on. Its one-time state is in
// account-link-cookie.ts.

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
