import { describe, expect, test } from "bun:test";
import { slackEventsUrl, slackLinkRedirectUrl } from "@werft-ai/chat-slack";
import {
  computedEventsBase,
  consoleOriginFrom,
  parseEventsPublicUrl,
  SlackConfigError,
  slackApiUrlFrom,
  slackApiUrlWarnings,
  slackEnvWarnings,
  slackIssuerFrom,
} from "./slack-config.ts";

const eventsBaseFrom = (env: Record<string, string | undefined>) =>
  computedEventsBase(consoleOriginFrom(env));

const ORIGIN = "https://werft.example";
const REDIRECT = `${ORIGIN}/settings/linked-accounts/slack`;
const AGENT = "019a0000-0000-7000-8000-0000000000a1";

describe("the public addresses computed from CONSOLE_ORIGIN", () => {
  test("the redirect is the console origin and the fixed link path", () => {
    const origin = consoleOriginFrom({ CONSOLE_ORIGIN: ORIGIN });
    expect(origin).toBe(ORIGIN);
    expect(slackLinkRedirectUrl(origin ?? "")).toBe(REDIRECT);
  });

  test("the events address is the console origin and the fixed events path", () => {
    const computed = eventsBaseFrom({ CONSOLE_ORIGIN: ORIGIN });
    expect(computed).toBe(ORIGIN);
    expect(slackEventsUrl(computed ?? "", AGENT)).toBe(
      `${ORIGIN}/v1/slack/events/${AGENT}`,
    );
  });

  test("a trailing slash or path on CONSOLE_ORIGIN changes nothing: only its origin counts", () => {
    expect(consoleOriginFrom({ CONSOLE_ORIGIN: `${ORIGIN}/console/` })).toBe(
      ORIGIN,
    );
  });

  test("plain http reaches events only on a local host: Slack calls https", () => {
    expect(eventsBaseFrom({ CONSOLE_ORIGIN: "http://127.0.0.1:3000" })).toBe(
      "http://127.0.0.1:3000",
    );
    expect(eventsBaseFrom({ CONSOLE_ORIGIN: "http://werft.example" })).toBe(
      null,
    );
  });

  test("nothing is computed without a console origin", () => {
    expect(consoleOriginFrom({})).toBe(null);
    expect(eventsBaseFrom({})).toBe(null);
  });

  test("SLACK_EVENTS_PUBLIC_URL is no longer read: only CONSOLE_ORIGIN counts", () => {
    expect(
      eventsBaseFrom({
        CONSOLE_ORIGIN: ORIGIN,
        SLACK_EVENTS_PUBLIC_URL: "https://events.example.test/in/",
      }),
    ).toBe(ORIGIN);
    expect(
      eventsBaseFrom({
        SLACK_EVENTS_PUBLIC_URL: "https://events.example.test",
      }),
    ).toBe(null);
  });

  test("the console origin must be http(s)", () => {
    expect(() => consoleOriginFrom({ CONSOLE_ORIGIN: "/relative" })).toThrow(
      SlackConfigError,
    );
  });
});

describe("parseEventsPublicUrl", () => {
  test("keeps an https base and its path prefix, without the trailing slash", () => {
    expect(parseEventsPublicUrl("https://events.example.test")).toBe(
      "https://events.example.test",
    );
    expect(parseEventsPublicUrl("https://events.example.test/in/")).toBe(
      "https://events.example.test/in",
    );
    expect(parseEventsPublicUrl("https://events.example.test:8443/a/b")).toBe(
      "https://events.example.test:8443/a/b",
    );
    expect(parseEventsPublicUrl("https://events.example.test/한")).toBe(
      "https://events.example.test/%ED%95%9C",
    );
  });

  test.each([
    ["plain http, even on a local host", "http://127.0.0.1:3000"],
    ["a relative path", "/v1/slack"],
    ["not a URL", "events.example.test"],
    ["a query", "https://events.example.test/?a=1"],
    ["an empty query", "https://events.example.test/?"],
    ["a fragment", "https://events.example.test/#in"],
    ["an empty fragment", "https://events.example.test/#"],
    ["credentials", "https://user:pass@events.example.test"],
    ["a user alone", "https://user@events.example.test"],
    ["another scheme", "wss://events.example.test"],
    ["over 2048 characters", `https://events.example.test/${"a".repeat(2030)}`],
    [
      "a short path that encodes past 2048 characters",
      `https://events.example.test/${"한".repeat(230)}`,
    ],
  ])("refuses %s", (_, value) => {
    expect(parseEventsPublicUrl(value)).toBe(null);
  });
});

describe("settings an older deployment may still pass", () => {
  const removed = {
    SLACK_OIDC_REDIRECT_URI:
      "https://old.example/settings/linked-accounts/slack",
    SLACK_OIDC_CLIENT_ID: "client-canary",
    SLACK_OIDC_CLIENT_SECRET: "secret-canary",
  };

  test("are not read: without CONSOLE_ORIGIN nothing is computed, with it only it counts", () => {
    expect(consoleOriginFrom(removed)).toBe(null);
    expect(eventsBaseFrom(removed)).toBe(null);
    expect(consoleOriginFrom({ ...removed, CONSOLE_ORIGIN: ORIGIN })).toBe(
      ORIGIN,
    );
    expect(eventsBaseFrom({ ...removed, CONSOLE_ORIGIN: ORIGIN })).toBe(ORIGIN);
  });

  test("SLACK_API_URL and SLACK_OIDC_ISSUER are not read: Slack's own addresses stay", () => {
    const old = {
      SLACK_API_URL: "http://mock-slack:4020/api",
      SLACK_OIDC_ISSUER: "http://mock-slack:4020",
    };
    expect(slackApiUrlFrom(old)).toBe("https://slack.com/api");
    expect(slackIssuerFrom(old)).toBe("https://slack.com");
  });

  test("are not parsed either: a malformed old value does not stop the process", () => {
    expect(consoleOriginFrom({ SLACK_OIDC_REDIRECT_URI: "not a url" })).toBe(
      null,
    );
    expect(slackApiUrlFrom({ SLACK_API_URL: "not a url" })).toBe(
      "https://slack.com/api",
    );
  });

  test("give one warning that names them and carries no value", () => {
    const warnings = slackEnvWarnings({
      ...removed,
      SLACK_API_URL: "http://mock-slack:4020/api",
      SLACK_OIDC_ISSUER: "http://mock-slack:4020",
      CONSOLE_ORIGIN: ORIGIN,
    });
    expect(warnings).toEqual([
      "Ignored removed settings: SLACK_OIDC_REDIRECT_URI, SLACK_OIDC_CLIENT_ID, SLACK_OIDC_CLIENT_SECRET, SLACK_API_URL, SLACK_OIDC_ISSUER",
    ]);
    expect(
      slackEnvWarnings({ CONSOLE_ORIGIN: ORIGIN, SLACK_OIDC_CLIENT_ID: "x" }),
    ).toEqual(["Ignored removed settings: SLACK_OIDC_CLIENT_ID"]);
  });

  test("an empty one, as an old compose file passes it, is silent", () => {
    expect(
      slackEnvWarnings({
        CONSOLE_ORIGIN: ORIGIN,
        SLACK_OIDC_REDIRECT_URI: "",
        SLACK_OIDC_CLIENT_ID: "",
        SLACK_OIDC_CLIENT_SECRET: "",
      }),
    ).toEqual([]);
  });
});

describe("slackEnvWarnings", () => {
  test("a clean installation is silent", () => {
    expect(slackEnvWarnings({ CONSOLE_ORIGIN: ORIGIN })).toEqual([]);
  });

  test("a mock override warns once, whatever host it names, Slack's own and the mock's included", () => {
    for (const value of [
      "http://mock-slack:4020",
      "https://slack.com",
      "https://slack-proxy.example",
    ]) {
      expect(
        slackEnvWarnings({
          CONSOLE_ORIGIN: ORIGIN,
          MOCK_SLACK_API_URL: `${value}/api`,
          MOCK_SLACK_OIDC_ISSUER: value,
        }),
      ).toEqual([
        "Mock Slack override in use: MOCK_SLACK_API_URL, MOCK_SLACK_OIDC_ISSUER. It is for the mock Slack test stack only; remove it from operational config",
      ]);
    }
    expect(
      slackEnvWarnings({
        CONSOLE_ORIGIN: ORIGIN,
        MOCK_SLACK_OIDC_ISSUER: "http://mock-slack:4020",
      }),
    ).toEqual([
      "Mock Slack override in use: MOCK_SLACK_OIDC_ISSUER. It is for the mock Slack test stack only; remove it from operational config",
    ]);
  });

  test("the Slack role's warnings name the API address only", () => {
    expect(
      slackApiUrlWarnings({
        MOCK_SLACK_API_URL: "http://mock-slack:4020/api",
        MOCK_SLACK_OIDC_ISSUER: "http://mock-slack:4020",
      }),
    ).toEqual([
      "Mock Slack override in use: MOCK_SLACK_API_URL. It is for the mock Slack test stack only; remove it from operational config",
    ]);
    expect(
      slackApiUrlWarnings({ SLACK_API_URL: "http://mock-slack:4020/api" }),
    ).toEqual(["Ignored removed settings: SLACK_API_URL"]);
    expect(slackApiUrlWarnings({})).toEqual([]);
  });

  test("no warning carries a value", () => {
    const secret = "https://leak-canary.example/path-canary";
    const text = [
      ...slackEnvWarnings({
        CONSOLE_ORIGIN: ORIGIN,
        SLACK_OIDC_REDIRECT_URI: secret,
        SLACK_EVENTS_PUBLIC_URL: secret,
        SLACK_API_URL: secret,
        SLACK_OIDC_ISSUER: secret,
        MOCK_SLACK_API_URL: secret,
        MOCK_SLACK_OIDC_ISSUER: secret,
        SLACK_OIDC_CLIENT_ID: "client-canary",
        SLACK_OIDC_CLIENT_SECRET: "secret-canary",
      }),
      ...slackApiUrlWarnings({
        SLACK_API_URL: secret,
        MOCK_SLACK_API_URL: secret,
      }),
    ].join("\n");
    expect(text).not.toContain("canary");
  });
});

describe("slackApiUrlFrom", () => {
  test("defaults to Slack and takes a local mock over plain http", () => {
    expect(slackApiUrlFrom({})).toBe("https://slack.com/api");
    expect(
      slackApiUrlFrom({ MOCK_SLACK_API_URL: "http://mock-slack:4020/api/" }),
    ).toBe("http://mock-slack:4020/api");
  });

  test("plain http elsewhere would send tokens in clear text", () => {
    expect(() =>
      slackApiUrlFrom({ MOCK_SLACK_API_URL: "http://slack.example/api" }),
    ).toThrow("MOCK_SLACK_API_URL must be https (http only for a local mock)");
  });
});

describe("slackIssuerFrom", () => {
  test("defaults to Slack, trims a trailing slash, and accepts a local mock", () => {
    expect(slackIssuerFrom({})).toBe("https://slack.com");
    expect(
      slackIssuerFrom({ MOCK_SLACK_OIDC_ISSUER: "http://mock-slack:4020/" }),
    ).toBe("http://mock-slack:4020");
  });

  test("must be an absolute http(s) URL", () => {
    expect(() =>
      slackIssuerFrom({ MOCK_SLACK_OIDC_ISSUER: "/relative" }),
    ).toThrow("MOCK_SLACK_OIDC_ISSUER must be an absolute URL");
    expect(() =>
      slackIssuerFrom({ MOCK_SLACK_OIDC_ISSUER: "ftp://slack.example" }),
    ).toThrow(SlackConfigError);
  });
});
