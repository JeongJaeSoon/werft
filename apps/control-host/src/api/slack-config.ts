import { SLACK_API_URL, slackLinkRedirectUrl } from "../wiring/chat-slack.ts";

const PLAIN_HTTP_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "mock-slack",
]);

const SLACK_ISSUER = "https://slack.com";

export class SlackConfigError extends Error {}

type Env = Record<string, string | undefined>;

/** SLACK_API_URL, or Slack's own; tokens ride in a header, so https only. */
export function slackApiUrlFrom(env: Env): string {
  const value = (env.SLACK_API_URL || SLACK_API_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SlackConfigError("SLACK_API_URL must be an absolute URL");
  }
  const local = PLAIN_HTTP_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SlackConfigError(
      "SLACK_API_URL must be https (http only for a local mock)",
    );
  }
  return value;
}

export function slackIssuerFrom(env: Env): string {
  const value = (env.SLACK_OIDC_ISSUER || SLACK_ISSUER).replace(/\/+$/, "");
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new SlackConfigError("SLACK_OIDC_ISSUER must be an absolute URL");
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new SlackConfigError("SLACK_OIDC_ISSUER must be an http(s) URL");
  }
  return value;
}

function originOf(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SlackConfigError(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SlackConfigError(`${name} must be an http(s) URL`);
  }
  return url.origin;
}

export function consoleOriginFrom(env: Env): string | null {
  if (env.CONSOLE_ORIGIN) return originOf("CONSOLE_ORIGIN", env.CONSOLE_ORIGIN);
  if (env.SLACK_OIDC_REDIRECT_URI) {
    return originOf("SLACK_OIDC_REDIRECT_URI", env.SLACK_OIDC_REDIRECT_URI);
  }
  return null;
}

function computedEventsBase(consoleOrigin: string | null): string | null {
  if (consoleOrigin === null) return null;
  const url = new URL(consoleOrigin);
  // Slack calls https request URLs only.
  if (url.protocol === "https:") return url.origin;
  return PLAIN_HTTP_HOSTS.has(url.hostname) ? url.origin : null;
}

export function slackEventsPublicUrlFrom(env: Env): string | null {
  const value = env.SLACK_EVENTS_PUBLIC_URL;
  if (!value) return computedEventsBase(consoleOriginFrom(env));
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SlackConfigError(
      "SLACK_EVENTS_PUBLIC_URL must be an absolute URL",
    );
  }
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") {
    throw new SlackConfigError(
      "SLACK_EVENTS_PUBLIC_URL must be an https URL without a query",
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function parsed(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Startup warnings name the variable, never its value. */
export function slackEnvWarnings(env: Env): string[] {
  const warnings: string[] = [];
  const consoleOrigin = env.CONSOLE_ORIGIN
    ? originOf("CONSOLE_ORIGIN", env.CONSOLE_ORIGIN)
    : null;

  const redirect = parsed(env.SLACK_OIDC_REDIRECT_URI);
  if (env.SLACK_OIDC_REDIRECT_URI) {
    if (consoleOrigin === null) {
      warnings.push(
        "SLACK_OIDC_REDIRECT_URI is retired: its origin is used only because CONSOLE_ORIGIN is unset. Set CONSOLE_ORIGIN and remove it; the fallback ends in the next release",
      );
    } else if (
      redirect === null ||
      redirect.toString() !== slackLinkRedirectUrl(consoleOrigin)
    ) {
      warnings.push(
        "SLACK_OIDC_REDIRECT_URI mismatch: it differs from the address computed from CONSOLE_ORIGIN and is ignored. Remove it",
      );
    } else {
      warnings.push(
        "SLACK_OIDC_REDIRECT_URI is retired and ignored: the address is computed from CONSOLE_ORIGIN. Remove it",
      );
    }
  }

  if (env.SLACK_OIDC_CLIENT_ID || env.SLACK_OIDC_CLIENT_SECRET) {
    warnings.push(
      "SLACK_OIDC_CLIENT_ID and SLACK_OIDC_CLIENT_SECRET are retired and ignored: each workspace links Slack accounts with its own link app (Integrations > Slack). Remove them",
    );
  }

  const events = parsed(env.SLACK_EVENTS_PUBLIC_URL);
  if (events !== null) {
    const computed = computedEventsBase(consoleOriginFrom(env));
    if (
      computed !== null &&
      `${events.origin}${events.pathname}`.replace(/\/+$/, "") !== computed
    ) {
      warnings.push(
        "SLACK_EVENTS_PUBLIC_URL mismatch: it differs from the address computed from CONSOLE_ORIGIN. It is used because events enter apart from the console; remove it if they do not",
      );
    }
  }

  warnings.push(
    ...slackApiUrlWarnings(env),
    ...awayFromSlack("SLACK_OIDC_ISSUER", env.SLACK_OIDC_ISSUER, SLACK_ISSUER),
  );
  return warnings;
}

function awayFromSlack(
  name: string,
  value: string | undefined,
  standard: string,
): string[] {
  const url = parsed(value);
  if (
    url === null ||
    url.toString().replace(/\/+$/, "") === standard ||
    PLAIN_HTTP_HOSTS.has(url.hostname)
  ) {
    return [];
  }
  return [
    `${name} points away from Slack: it is for the mock Slack test stack only. Remove it from operational config`,
  ];
}

/**
 * The API address alone: the Slack role sends bot tokens to it as well, so it
 * warns on its own start, where the API's warnings are not seen.
 */
export function slackApiUrlWarnings(env: Env): string[] {
  return awayFromSlack("SLACK_API_URL", env.SLACK_API_URL, SLACK_API_URL);
}
