import { SLACK_LINK_USER_SCOPES } from "./slack-manifest.ts";

// Sign in with Slack (Slack's OpenID Connect), used only to prove which
// Slack account a logged-in person holds. No Slack token is kept: the
// id_token is read once and dropped. Requests and id_token verification
// come from the platform's OIDC client, passed in as a SlackOidcTransport.

export type SlackOidcConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** `https://slack.com`, or a mock IdP's base URL in tests and local runs. */
  issuer: string;
};

/** The IdP refused the code or returned a token that does not verify. */
export class SlackOidcRejectedError extends Error {}
/**
 * The IdP could not be reached, answered with a server error, or sits at an
 * address the network policy refuses.
 */
export class SlackOidcUnavailableError extends Error {}

/**
 * What the platform's OIDC client does for this flow. Both throw
 * SlackOidcRejectedError or SlackOidcUnavailableError.
 */
export type SlackOidcTransport = {
  /** A form POST under the network policy; any answer below 500 comes back. */
  postForm(
    url: string,
    form: URLSearchParams,
  ): Promise<{ status: number; text: string }>;
  /** The claims of an id_token signed by a key from `jwksUri`. */
  verifyIdToken(
    idToken: string,
    expected: {
      jwksUri: string;
      issuer: string;
      clientId: string;
      nonce: string;
    },
  ): Promise<Record<string, unknown>>;
};

export function slackLinkAuthorizeUrl(
  config: SlackOidcConfig,
  attempt: { state: string; nonce: string },
  team: string | null,
): string {
  const url = new URL(`${config.issuer}/openid/connect/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    // No email: people are never matched by address.
    scope: SLACK_LINK_USER_SCOPES.join(" "),
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state: attempt.state,
    nonce: attempt.nonce,
    // Slack opens the consent screen on this team instead of asking.
    ...(team ? { team } : {}),
  }).toString();
  return url.toString();
}

export type VerifiedSlackAccount = {
  teamId: string;
  userId: string;
  teamName: string | null;
  userName: string | null;
};

function claim(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A name too long for the API's 255 is dropped; the page shows the id. */
function displayName(
  payload: Record<string, unknown>,
  name: string,
): string | null {
  const value = claim(payload, name)?.trim();
  return value && value.length <= 255 ? value : null;
}

function tokenAnswer(
  text: string,
): { ok?: unknown; id_token?: unknown; error?: unknown } | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

export async function exchangeSlackCode(
  config: SlackOidcConfig,
  transport: SlackOidcTransport,
  code: string,
  expectedNonce: string,
): Promise<VerifiedSlackAccount> {
  const response = await transport.postForm(
    `${config.issuer}/api/openid.connect.token`,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  );
  const body = tokenAnswer(response.text);
  if (body?.ok !== true || typeof body.id_token !== "string") {
    throw new SlackOidcRejectedError(
      `Slack refused the code: ${typeof body?.error === "string" ? body.error : "no id_token"}`,
    );
  }
  const payload = await transport.verifyIdToken(body.id_token, {
    jwksUri: `${config.issuer}/openid/connect/keys`,
    issuer: config.issuer,
    clientId: config.clientId,
    nonce: expectedNonce,
  });
  const teamId = claim(payload, "https://slack.com/team_id");
  const userId =
    claim(payload, "https://slack.com/user_id") ?? claim(payload, "sub");
  if (teamId === null || userId === null) {
    throw new SlackOidcRejectedError("id_token names no Slack team or user");
  }
  return {
    teamId,
    userId,
    // Display only, from the `profile` scope: `name` is the person's display
    // name; the team name is the claim openid.connect.userInfo documents.
    teamName: displayName(payload, "https://slack.com/team_name"),
    userName: displayName(payload, "name"),
  };
}
