import { describe, expect, test } from "bun:test";
import { slackEventsUrl, slackLinkRedirectUrl } from "@werft-ai/platform";
import {
  consoleOriginFrom,
  SlackConfigError,
  slackEnvWarnings,
  slackEventsPublicUrlFrom,
  slackIssuerFrom,
} from "./slack-config.ts";

const ORIGIN = "https://werft.example";
const LEGACY_REDIRECT = `${ORIGIN}/settings/linked-accounts/slack`;
const AGENT = "019a0000-0000-7000-8000-0000000000a1";

describe("the public addresses computed from CONSOLE_ORIGIN", () => {
  test("the redirect equals what SLACK_OIDC_REDIRECT_URI held for the same console", () => {
    const origin = consoleOriginFrom({ CONSOLE_ORIGIN: ORIGIN });
    expect(origin).toBe(ORIGIN);
    expect(slackLinkRedirectUrl(origin ?? "")).toBe(LEGACY_REDIRECT);
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

describe("the retired SLACK_OIDC_REDIRECT_URI", () => {
  test("still names the console until the next release, when CONSOLE_ORIGIN is unset", () => {
    expect(
      consoleOriginFrom({ SLACK_OIDC_REDIRECT_URI: LEGACY_REDIRECT }),
    ).toBe(ORIGIN);
  });

  test("CONSOLE_ORIGIN wins over it", () => {
    expect(
      consoleOriginFrom({
        CONSOLE_ORIGIN: "https://other.example",
        SLACK_OIDC_REDIRECT_URI: LEGACY_REDIRECT,
      }),
    ).toBe("https://other.example");
  });
});

describe("slackEnvWarnings", () => {
  test("a clean installation is silent", () => {
    expect(slackEnvWarnings({ CONSOLE_ORIGIN: ORIGIN })).toEqual([]);
  });

  test("a redirect that matches the computed one is retired, a different one is a mismatch", () => {
    const same = slackEnvWarnings({
      CONSOLE_ORIGIN: ORIGIN,
      SLACK_OIDC_REDIRECT_URI: LEGACY_REDIRECT,
    });
    expect(same).toHaveLength(1);
    expect(same[0]).toContain("retired");
    const other = slackEnvWarnings({
      CONSOLE_ORIGIN: ORIGIN,
      SLACK_OIDC_REDIRECT_URI:
        "https://other.example/settings/linked-accounts/slack",
    });
    expect(other).toHaveLength(1);
    expect(other[0]).toContain("mismatch");
  });

  test("a redirect that stands in for CONSOLE_ORIGIN is called out as a fallback", () => {
    const warnings = slackEnvWarnings({
      SLACK_OIDC_REDIRECT_URI: LEGACY_REDIRECT,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("CONSOLE_ORIGIN");
    expect(warnings[0]).toContain("fallback");
  });

  test("a leftover client id or secret is ignored with a warning", () => {
    expect(
      slackEnvWarnings({ CONSOLE_ORIGIN: ORIGIN, SLACK_OIDC_CLIENT_ID: "x" }),
    ).toHaveLength(1);
    expect(
      slackEnvWarnings({
        CONSOLE_ORIGIN: ORIGIN,
        SLACK_OIDC_CLIENT_SECRET: "x",
      }),
    ).toHaveLength(1);
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
