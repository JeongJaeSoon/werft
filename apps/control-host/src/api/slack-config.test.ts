import { describe, expect, test } from "bun:test";
import { slackEventsUrl, slackLinkRedirectUrl } from "@werft-ai/chat-slack";
import {
  consoleOriginFrom,
  SlackConfigError,
  slackApiUrlWarnings,
  slackEnvWarnings,
  slackEventsPublicUrlFrom,
  slackIssuerFrom,
} from "./slack-config.ts";

const ORIGIN = "https://werft.example";
const REDIRECT = `${ORIGIN}/settings/linked-accounts/slack`;
const AGENT = "019a0000-0000-7000-8000-0000000000a1";

describe("the public addresses computed from CONSOLE_ORIGIN", () => {
  test("the redirect is the console origin and the fixed link path", () => {
    const origin = consoleOriginFrom({ CONSOLE_ORIGIN: ORIGIN });
    expect(origin).toBe(ORIGIN);
    expect(slackLinkRedirectUrl(origin ?? "")).toBe(REDIRECT);
  });

  test("the events address equals what SLACK_EVENTS_PUBLIC_URL held for the same console", () => {
    const computed = slackEventsPublicUrlFrom({ CONSOLE_ORIGIN: ORIGIN });
    const legacy = slackEventsPublicUrlFrom({
      SLACK_EVENTS_PUBLIC_URL: ORIGIN,
    });
    expect(computed).toBe(legacy);
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
    expect(
      slackEventsPublicUrlFrom({ CONSOLE_ORIGIN: "http://127.0.0.1:3000" }),
    ).toBe("http://127.0.0.1:3000");
    expect(
      slackEventsPublicUrlFrom({ CONSOLE_ORIGIN: "http://werft.example" }),
    ).toBeNull();
  });

  test("nothing is computed without a console origin", () => {
    expect(consoleOriginFrom({})).toBeNull();
    expect(slackEventsPublicUrlFrom({})).toBeNull();
  });

  test("SLACK_EVENTS_PUBLIC_URL still wins, with its path prefix, when events enter apart from the console", () => {
    expect(
      slackEventsPublicUrlFrom({
        CONSOLE_ORIGIN: ORIGIN,
        SLACK_EVENTS_PUBLIC_URL: "https://events.example.test/in/",
      }),
    ).toBe("https://events.example.test/in");
  });

  test("a malformed override stops the process; the console origin must be http(s)", () => {
    expect(() =>
      slackEventsPublicUrlFrom({ SLACK_EVENTS_PUBLIC_URL: "http://x.test" }),
    ).toThrow(SlackConfigError);
    expect(() => consoleOriginFrom({ CONSOLE_ORIGIN: "/relative" })).toThrow(
      SlackConfigError,
    );
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
    expect(consoleOriginFrom(removed)).toBeNull();
    expect(slackEventsPublicUrlFrom(removed)).toBeNull();
    expect(consoleOriginFrom({ ...removed, CONSOLE_ORIGIN: ORIGIN })).toBe(
      ORIGIN,
    );
    expect(
      slackEventsPublicUrlFrom({ ...removed, CONSOLE_ORIGIN: ORIGIN }),
    ).toBe(ORIGIN);
  });

  test("are not parsed either: a malformed old redirect does not stop the process", () => {
    expect(
      consoleOriginFrom({ SLACK_OIDC_REDIRECT_URI: "not a url" }),
    ).toBeNull();
  });

  test("give one warning that names them and carries no value", () => {
    const warnings = slackEnvWarnings({ ...removed, CONSOLE_ORIGIN: ORIGIN });
    expect(warnings).toEqual([
      "Ignored removed settings: SLACK_OIDC_REDIRECT_URI, SLACK_OIDC_CLIENT_ID, SLACK_OIDC_CLIENT_SECRET",
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

  test("an events override that differs from the computed address is flagged, an equal one is not", () => {
    expect(
      slackEnvWarnings({
        CONSOLE_ORIGIN: ORIGIN,
        SLACK_EVENTS_PUBLIC_URL: "https://events.example.test",
      })[0],
    ).toContain("mismatch");
    expect(
      slackEnvWarnings({
        CONSOLE_ORIGIN: ORIGIN,
        SLACK_EVENTS_PUBLIC_URL: `${ORIGIN}/`,
      }),
    ).toEqual([]);
  });

  test("SLACK_API_URL and SLACK_OIDC_ISSUER away from Slack are test-only; the mock hosts and Slack itself are silent", () => {
    for (const name of ["SLACK_API_URL", "SLACK_OIDC_ISSUER"] as const) {
      const warnings = slackEnvWarnings({
        CONSOLE_ORIGIN: ORIGIN,
        [name]: "https://slack-proxy.example",
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(name);
      expect(warnings[0]).toContain("test stack only");
    }
    expect(
      slackEnvWarnings({
        CONSOLE_ORIGIN: "http://127.0.0.1:3000",
        SLACK_API_URL: "http://mock-slack:4020/api",
        SLACK_OIDC_ISSUER: "http://mock-slack:4020",
      }),
    ).toEqual([]);
    expect(
      slackEnvWarnings({
        CONSOLE_ORIGIN: ORIGIN,
        SLACK_API_URL: "https://slack.com/api/",
        SLACK_OIDC_ISSUER: "https://slack.com",
      }),
    ).toEqual([]);
  });

  test("the Slack role's API warning names SLACK_API_URL only", () => {
    const warnings = slackApiUrlWarnings({
      SLACK_API_URL: "https://slack-proxy.example/api",
      SLACK_OIDC_ISSUER: "https://slack-proxy.example",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("SLACK_API_URL");
    expect(warnings[0]).not.toContain("slack-proxy.example");
    expect(
      slackApiUrlWarnings({ SLACK_API_URL: "http://mock-slack:4020/api" }),
    ).toEqual([]);
    expect(slackApiUrlWarnings({})).toEqual([]);
  });

  test("no warning carries a value", () => {
    const secret = "https://leak-canary.example/path-canary";
    const text = slackEnvWarnings({
      CONSOLE_ORIGIN: ORIGIN,
      SLACK_OIDC_REDIRECT_URI: secret,
      SLACK_EVENTS_PUBLIC_URL: secret,
      SLACK_API_URL: secret,
      SLACK_OIDC_ISSUER: secret,
      SLACK_OIDC_CLIENT_ID: "client-canary",
      SLACK_OIDC_CLIENT_SECRET: "secret-canary",
    }).join("\n");
    expect(text).not.toContain("canary");
  });
});

describe("slackIssuerFrom", () => {
  test("defaults to Slack, trims a trailing slash, and accepts a local mock", () => {
    expect(slackIssuerFrom({})).toBe("https://slack.com");
    expect(
      slackIssuerFrom({ SLACK_OIDC_ISSUER: "http://mock-slack:4020/" }),
    ).toBe("http://mock-slack:4020");
  });

  test("must be an absolute http(s) URL", () => {
    expect(() => slackIssuerFrom({ SLACK_OIDC_ISSUER: "/relative" })).toThrow(
      SlackConfigError,
    );
    expect(() =>
      slackIssuerFrom({ SLACK_OIDC_ISSUER: "ftp://slack.example" }),
    ).toThrow(SlackConfigError);
  });
});
