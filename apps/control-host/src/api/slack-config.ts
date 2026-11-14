import { SLACK_EVENTS_PUBLIC_URL_MAX } from "@werft-ai/contracts";
import { SLACK_API_URL } from "../wiring/chat-slack.ts";

const PLAIN_HTTP_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "mock-slack",
]);

const SLACK_ISSUER = "https://slack.com";

export class SlackConfigError extends Error {}

type Env = Record<string, string | undefined>;

/**
 * MOCK_SLACK_API_URL, or Slack's own; tokens ride in a header, so https only.
 * The MOCK_ prefix says it at the place it is set: only a mock Slack test
 * stack points this anywhere else.
 */
export function slackApiUrlFrom(env: Env): string {
  const value = (env.MOCK_SLACK_API_URL || SLACK_API_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SlackConfigError("MOCK_SLACK_API_URL must be an absolute URL");
  }
  const local = PLAIN_HTTP_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SlackConfigError(
      "MOCK_SLACK_API_URL must be https (http only for a local mock)",
    );
  }
  return value;
}

export function slackIssuerFrom(env: Env): string {
  const value = (env.MOCK_SLACK_OIDC_ISSUER || SLACK_ISSUER).replace(
    /\/+$/,
    "",
  );
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new SlackConfigError(
      "MOCK_SLACK_OIDC_ISSUER must be an absolute URL",
    );
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new SlackConfigError("MOCK_SLACK_OIDC_ISSUER must be an http(s) URL");
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

/**
 * CONSOLE_ORIGIN and nothing else. Sign-in providers build their redirect
 * URIs on this: an origin guessed from another setting would be registered
 * at the provider and then change under it.
 */
export function consoleOriginFrom(env: Env): string | null {
  return env.CONSOLE_ORIGIN
    ? originOf("CONSOLE_ORIGIN", env.CONSOLE_ORIGIN)
    : null;
}

/** The events base when no address is saved: the console's own origin. */
export function computedEventsBase(
  consoleOrigin: string | null,
): string | null {
  if (consoleOrigin === null) return null;
  const url = new URL(consoleOrigin);
  // Slack calls https request URLs only.
  if (url.protocol === "https:") return url.origin;
  return PLAIN_HTTP_HOSTS.has(url.hostname) ? url.origin : null;
}

/**
 * A saved events address, without its trailing slash; null when it is not
 * an absolute https URL free of a query, fragment and credentials. A path
 * prefix stays: a proxy in front may route on it.
 */
export function parseEventsPublicUrl(value: string): string | null {
  if (value.length > SLACK_EVENTS_PUBLIC_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    // `https://host?` parses with an empty search; the text still had one.
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Settings an older deployment may still pass. Nothing reads them; the Slack
 * link redirect comes from CONSOLE_ORIGIN and each workspace's link app holds
 * its own client.
 */
const REMOVED_SLACK_ENV = [
  "SLACK_OIDC_REDIRECT_URI",
  "SLACK_OIDC_CLIENT_ID",
  "SLACK_OIDC_CLIENT_SECRET",
  // Renamed to MOCK_SLACK_API_URL and MOCK_SLACK_OIDC_ISSUER.
  "SLACK_API_URL",
  "SLACK_OIDC_ISSUER",
] as const;

/** Startup warnings name the variable, never its value. */
export function slackEnvWarnings(env: Env): string[] {
  const warnings: string[] = [];
  const removed = REMOVED_SLACK_ENV.filter((name) => env[name]);
  if (removed.length > 0) {
    warnings.push(`Ignored removed settings: ${removed.join(", ")}`);
  }
  warnings.push(
    ...mockOverrides(env, ["MOCK_SLACK_API_URL", "MOCK_SLACK_OIDC_ISSUER"]),
  );
  return warnings;
}

/** Any value counts, whatever its host: only a test stack sets these. */
function mockOverrides(env: Env, names: readonly string[]): string[] {
  const set = names.filter((name) => env[name]);
  if (set.length === 0) return [];
  return [
    `Mock Slack override in use: ${set.join(", ")}. It is for the mock Slack test stack only; remove it from operational config`,
  ];
}

/**
 * The API address alone: the Slack role sends bot tokens to it as well, so it
 * warns on its own start, where the API's warnings are not seen.
 */
export function slackApiUrlWarnings(env: Env): string[] {
  return [
    ...(env.SLACK_API_URL ? ["Ignored removed settings: SLACK_API_URL"] : []),
    ...mockOverrides(env, ["MOCK_SLACK_API_URL"]),
  ];
}
