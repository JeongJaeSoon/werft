import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  ACCOUNT_LINK_TTL_MS,
  createAccountLinkCookies,
  GITHUB_LINK_COOKIE_NAME,
  SLACK_LINK_COOKIE_NAME,
} from "./account-link-cookie.ts";
import { createCookieSealer, createFlowSealer } from "./oidc/flow-cookie.ts";

const KEY = randomBytes(32);
const PERSON = "019a0000-0000-7000-8000-0000000000a1";
const CONNECTION = "019a0000-0000-7000-8000-0000000000c9";
const T0 = 1_800_000_000_000;

/** Start and callback routes for both links, on a clock the test moves. */
function harness(key = KEY) {
  const clock = { now: T0 };
  const cookies = createAccountLinkCookies(key, () => clock.now);
  const app = new Hono();
  app.post("/v1/linked-accounts/slack/start", (c) =>
    c.json(cookies.issueSlack(c, PERSON)),
  );
  app.post("/v1/linked-accounts/github/start", (c) =>
    c.json(cookies.issueGitHub(c, PERSON, CONNECTION)),
  );
  app.post("/v1/linked-accounts/:provider/callback", async (c) => {
    const { state, user } = await c.req.json();
    return c.json({
      bound:
        c.req.param("provider") === "slack"
          ? cookies.consumeSlack(c, state, user ?? PERSON)
          : cookies.consumeGitHub(c, state, user ?? PERSON),
    });
  });
  const start = async (provider: "slack" | "github") => {
    const response = await app.request(
      `/v1/linked-accounts/${provider}/start`,
      { method: "POST" },
    );
    const header = response.headers.get("Set-Cookie") ?? "";
    const issued = (await response.json()) as {
      state: string;
      nonce?: string;
      expiresAt: string;
    };
    return { header, value: header.split(";")[0] ?? "", issued };
  };
  const callback = async (
    provider: "slack" | "github",
    cookie: string | null,
    state: string,
    user?: string,
  ) => {
    const response = await app.request(
      `/v1/linked-accounts/${provider}/callback`,
      {
        method: "POST",
        headers: cookie === null ? {} : { Cookie: cookie },
        body: JSON.stringify({ state, user }),
      },
    );
    return {
      bound: ((await response.json()) as { bound: string | null }).bound,
      setCookie: response.headers.get("Set-Cookie") ?? "",
    };
  };
  return { clock, start, callback };
}

/** A cookie value sealed as this module seals one, around any JSON. */
function sealed(name: string, payload: unknown, key = KEY): string {
  return `${name}=${createCookieSealer(key, name, (v) => v).seal(payload)}`;
}

const slackFlow = {
  purpose: "link",
  provider: "slack",
  state: "s".repeat(43),
  userId: PERSON,
  startedAt: T0,
  nonce: "n".repeat(43),
};
const githubFlow = {
  purpose: "link",
  provider: "github",
  state: "g".repeat(43),
  userId: PERSON,
  startedAt: T0,
  connectionId: CONNECTION,
};

describe("the cookie a link start sets", () => {
  test.each([
    ["slack", SLACK_LINK_COOKIE_NAME, "/v1/linked-accounts/slack"],
    ["github", GITHUB_LINK_COOKIE_NAME, "/v1/linked-accounts/github"],
  ] as const)(
    "%s: HttpOnly, Secure, SameSite=Lax, scoped to the callback, ten minutes",
    async (provider, name, path) => {
      const { header, issued } = await harness().start(provider);
      expect(header.startsWith(`${name}=`)).toBe(true);
      const attributes = header.split("; ").slice(1);
      expect(attributes).toContain("HttpOnly");
      expect(attributes).toContain("Secure");
      expect(attributes).toContain("SameSite=Lax");
      expect(attributes).toContain(`Path=${path}`);
      const expires = new Date(T0 + ACCOUNT_LINK_TTL_MS);
      expect(attributes).toContain(`Expires=${expires.toUTCString()}`);
      expect(issued.expiresAt).toBe(expires.toISOString());
      expect(ACCOUNT_LINK_TTL_MS).toBe(10 * 60 * 1000);
    },
  );

  test("its value is sealed: no state, nonce, person or connection shows", async () => {
    const h = harness();
    for (const provider of ["slack", "github"] as const) {
      const { value, issued } = await h.start(provider);
      const raw = value.slice(value.indexOf("=") + 1);
      const text = Buffer.from(raw, "base64url").toString("latin1");
      for (const secret of [issued.state, issued.nonce, PERSON, CONNECTION]) {
        if (secret === undefined) continue;
        expect(raw).not.toContain(secret);
        expect(text).not.toContain(secret);
      }
      // Before: `state.nonce.user` (Slack), `state.user.expires.connection` (GitHub).
      expect(raw).not.toContain(".");
    }
  });
});

describe("a link callback", () => {
  test("gets what its own start bound, and clears the cookie", async () => {
    const h = harness();
    const slack = await h.start("slack");
    const slackEnd = await h.callback("slack", slack.value, slack.issued.state);
    expect(slackEnd.bound).toBe(slack.issued.nonce ?? "missing");
    expect(slackEnd.setCookie).toStartWith(`${SLACK_LINK_COOKIE_NAME}=;`);
    expect(slackEnd.setCookie).toContain("Path=/v1/linked-accounts/slack");

    const github = await h.start("github");
    const githubEnd = await h.callback(
      "github",
      github.value,
      github.issued.state,
    );
    expect(githubEnd.bound).toBe(CONNECTION);
    expect(githubEnd.setCookie).toStartWith(`${GITHUB_LINK_COOKIE_NAME}=;`);
  });

  test("a state is spent once: the cleared cookie a reused state comes with does not open", async () => {
    const h = harness();
    for (const provider of ["slack", "github"] as const) {
      const { value, issued } = await h.start(provider);
      const first = await h.callback(provider, value, issued.state);
      expect(first.bound).not.toBeNull();
      const cleared = first.setCookie.split(";")[0] ?? "";
      expect(cleared).toBe(`${value.slice(0, value.indexOf("="))}=`);
      expect(
        (await h.callback(provider, cleared, issued.state)).bound,
      ).toBeNull();
    }
  });

  test("past ten minutes on the server's clock is refused, also for Slack", async () => {
    // Before: a Slack cookie still sent was taken at any age; only the
    // browser's Expires ended it.
    for (const provider of ["slack", "github"] as const) {
      const h = harness();
      const { value, issued } = await h.start(provider);
      h.clock.now = T0 + ACCOUNT_LINK_TTL_MS - 1;
      expect(
        (await h.callback(provider, value, issued.state)).bound,
      ).not.toBeNull();
      h.clock.now = T0 + ACCOUNT_LINK_TTL_MS;
      expect(
        (await h.callback(provider, value, issued.state)).bound,
      ).toBeNull();
    }
  });

  test("a start up to a minute ahead of this clock is taken, further ahead is not", async () => {
    for (const provider of ["slack", "github"] as const) {
      const h = harness();
      const { value, issued } = await h.start(provider);
      h.clock.now = T0 - 60_000;
      expect(
        (await h.callback(provider, value, issued.state)).bound,
      ).not.toBeNull();
      h.clock.now = T0 - 60_001;
      expect(
        (await h.callback(provider, value, issued.state)).bound,
      ).toBeNull();
    }
  });

  test("another browser (no cookie), another state or another person is refused", async () => {
    const h = harness();
    for (const provider of ["slack", "github"] as const) {
      const { value, issued } = await h.start(provider);
      expect((await h.callback(provider, null, issued.state)).bound).toBeNull();
      expect(
        (await h.callback(provider, value, "other-state")).bound,
      ).toBeNull();
      expect(
        (
          await h.callback(
            provider,
            value,
            issued.state,
            "019a0000-0000-7000-8000-0000000000ff",
          )
        ).bound,
      ).toBeNull();
    }
  });

  test("a value sealed with another key, for the other link or as a sign-in flow does not open", async () => {
    const h = harness();
    const slackCallback = (cookie: string) =>
      h.callback("slack", cookie, slackFlow.state);
    // The helper stands in for the module's own seal.
    expect(
      (await slackCallback(sealed(SLACK_LINK_COOKIE_NAME, slackFlow))).bound,
    ).toBe(slackFlow.nonce);
    expect(
      (
        await slackCallback(
          sealed(SLACK_LINK_COOKIE_NAME, slackFlow, randomBytes(32)),
        )
      ).bound,
    ).toBeNull();
    // A GitHub link's value under the Slack cookie's name.
    const github = await h.start("github");
    const moved = `${SLACK_LINK_COOKIE_NAME}=${github.value.split("=")[1]}`;
    expect(
      (await h.callback("slack", moved, github.issued.state)).bound,
    ).toBeNull();
    // A sign-in flow sealed with this very key.
    const login = createFlowSealer(KEY, SLACK_LINK_COOKIE_NAME).seal({
      purpose: "link",
      providerId: "p",
      configRevision: 1,
      state: slackFlow.state,
      nonce: slackFlow.nonce,
      verifier: "v",
      startedAt: T0,
      link: { userId: PERSON, sessionId: "s" },
    });
    expect(
      (await slackCallback(`${SLACK_LINK_COOKIE_NAME}=${login}`)).bound,
    ).toBeNull();
  });

  test("a cookie in the format before sealing is refused: a link in flight at the upgrade starts over", async () => {
    const h = harness();
    const state = "s".repeat(43);
    expect(
      (
        await h.callback(
          "slack",
          `${SLACK_LINK_COOKIE_NAME}=${state}.${"n".repeat(43)}.${PERSON}`,
          state,
        )
      ).bound,
    ).toBeNull();
    expect(
      (
        await h.callback(
          "github",
          `${GITHUB_LINK_COOKIE_NAME}=${state}.${PERSON}.${T0 + 60_000}.${CONNECTION}`,
          state,
        )
      ).bound,
    ).toBeNull();
  });

  test("a sealed value that is not a whole link of its provider does not open", async () => {
    const h = harness();
    const broken: [string, unknown][] = [
      ["slack", { ...slackFlow, purpose: "login" }],
      ["slack", { ...slackFlow, provider: "github" }],
      ["slack", { ...slackFlow, nonce: undefined }],
      ["slack", { ...slackFlow, nonce: "" }],
      ["slack", { ...slackFlow, connectionId: CONNECTION }],
      ["slack", { ...slackFlow, userId: "" }],
      ["slack", { ...slackFlow, startedAt: String(T0) }],
      ["slack", { ...slackFlow, startedAt: T0 + 0.5 }],
      ["github", { ...githubFlow, connectionId: undefined }],
      ["github", { ...githubFlow, nonce: "n" }],
      ["github", { ...githubFlow, state: 7 }],
      ["github", null],
    ];
    for (const [provider, payload] of broken) {
      const name =
        provider === "slack" ? SLACK_LINK_COOKIE_NAME : GITHUB_LINK_COOKIE_NAME;
      const state = provider === "slack" ? slackFlow.state : githubFlow.state;
      expect(
        (await h.callback(provider as "slack", sealed(name, payload), state))
          .bound,
        JSON.stringify(payload),
      ).toBeNull();
    }
    expect(
      (
        await h.callback(
          "github",
          sealed(GITHUB_LINK_COOKIE_NAME, githubFlow),
          githubFlow.state,
        )
      ).bound,
    ).toBe(CONNECTION);
  });
});
