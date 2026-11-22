import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createCookieSealer } from "./oidc/flow-cookie.ts";
import { sameString } from "./same-string.ts";

// The one-time state of linking a signed-in person's Slack or GitHub
// account, held by the browser in a sealed cookie scoped to the callback:
// the server keeps no record, and the callback spends the cookie.

export const SLACK_LINK_COOKIE_NAME = "werft_slack_link";
export const GITHUB_LINK_COOKIE_NAME = "werft_github_link";
export const ACCOUNT_LINK_TTL_MS = 10 * 60 * 1000;
/** How far ahead of this server's clock another replica's start may be. */
const CLOCK_SKEW_MS = 60 * 1000;

type Provider = "slack" | "github";

/** One link, from its start request to its callback. */
type AccountLinkFlow = {
  purpose: "link";
  provider: Provider;
  /** Never logged. */
  state: string;
  /** Who started it; only they can end it. */
  userId: string;
  /** Milliseconds since the epoch, on the starting server's clock. */
  startedAt: number;
  /** Slack: the id_token's nonce. Never logged. */
  nonce?: string;
  /** GitHub: the App connection whose client the state was issued for. */
  connectionId?: string;
};

const COOKIES: Record<Provider, { name: string; path: string }> = {
  slack: { name: SLACK_LINK_COOKIE_NAME, path: "/v1/linked-accounts/slack" },
  github: { name: GITHUB_LINK_COOKIE_NAME, path: "/v1/linked-accounts/github" },
};

const text = (value: unknown) => typeof value === "string" && value !== "";

function linkFlowOf(provider: Provider) {
  return (value: unknown): AccountLinkFlow | null => {
    if (typeof value !== "object" || value === null) return null;
    const flow = value as Record<string, unknown>;
    // What each provider's callback needs, and nothing of the other's.
    const bound =
      provider === "slack"
        ? text(flow.nonce) && flow.connectionId === undefined
        : text(flow.connectionId) && flow.nonce === undefined;
    return flow.purpose === "link" &&
      flow.provider === provider &&
      text(flow.state) &&
      text(flow.userId) &&
      Number.isSafeInteger(flow.startedAt) &&
      bound
      ? (value as AccountLinkFlow)
      : null;
  };
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * `key` is 32 bytes kept for sealing these cookies alone. A cookie that does
 * not open, is past ten minutes, was started by someone else or carries
 * another state ends the callback the same way: start over.
 */
export function createAccountLinkCookies(
  key: Buffer,
  now: () => number = Date.now,
) {
  const sealers = {
    slack: createCookieSealer(key, SLACK_LINK_COOKIE_NAME, linkFlowOf("slack")),
    github: createCookieSealer(
      key,
      GITHUB_LINK_COOKIE_NAME,
      linkFlowOf("github"),
    ),
  };
  const options = (provider: Provider) =>
    ({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: COOKIES[provider].path,
    }) as const;

  const issue = (
    context: Context,
    flow: Omit<AccountLinkFlow, "purpose" | "state" | "startedAt">,
  ) => {
    const startedAt = now();
    const sealed: AccountLinkFlow = {
      purpose: "link",
      state: token(),
      startedAt,
      ...flow,
    };
    const expiresAt = new Date(startedAt + ACCOUNT_LINK_TTL_MS);
    setCookie(
      context,
      COOKIES[flow.provider].name,
      sealers[flow.provider].seal(sealed),
      { ...options(flow.provider), expires: expiresAt },
    );
    return { flow: sealed, expiresAt };
  };

  /** Spends the cookie whatever the outcome; null unless it matches. */
  const consume = (
    context: Context,
    provider: Provider,
    state: string,
    userId: string,
  ): AccountLinkFlow | null => {
    const { name } = COOKIES[provider];
    const flow = sealers[provider].open(getCookie(context, name));
    deleteCookie(context, name, options(provider));
    if (flow === null) return null;
    const age = now() - flow.startedAt;
    if (age >= ACCOUNT_LINK_TTL_MS || age < -CLOCK_SKEW_MS) return null;
    return sameString(flow.state, state) && flow.userId === userId
      ? flow
      : null;
  };

  return {
    issueSlack(context: Context, userId: string) {
      const { flow, expiresAt } = issue(context, {
        provider: "slack",
        userId,
        nonce: token(),
      });
      return { state: flow.state, nonce: flow.nonce as string, expiresAt };
    },
    /** The nonce the id_token must carry, or null. */
    consumeSlack(context: Context, state: string, userId: string) {
      return consume(context, "slack", state, userId)?.nonce ?? null;
    },
    issueGitHub(context: Context, userId: string, connectionId: string) {
      const { flow, expiresAt } = issue(context, {
        provider: "github",
        userId,
        connectionId,
      });
      return { state: flow.state, expiresAt };
    },
    /** The connection the state was issued for, or null. */
    consumeGitHub(context: Context, state: string, userId: string) {
      return consume(context, "github", state, userId)?.connectionId ?? null;
    },
  };
}

export type AccountLinkCookies = ReturnType<typeof createAccountLinkCookies>;
