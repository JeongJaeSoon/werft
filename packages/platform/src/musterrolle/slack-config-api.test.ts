import { describe, expect, test } from "bun:test";
import { createSlackConfigApi, SlackApiError } from "./slack-config-api.ts";

const INPUT = {
  clientId: "9000.1",
  clientSecret: ["fixture", "client", "value"].join("-"),
  code: ["fixture", "grant", "code"].join("-"),
  redirectUri: "https://console.example.ts.net/agents/a/slack/callback",
};

async function failureOf(
  answer: () => Response | Promise<Response>,
  call: (api: ReturnType<typeof createSlackConfigApi>) => Promise<unknown> = (
    api,
  ) => api.exchangeInstallCode(INPUT),
) {
  const api = createSlackConfigApi({
    apiUrl: "http://slack.invalid/api",
    fetch: (async () => answer()) as unknown as typeof fetch,
  });
  const error = await call(api).then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof SlackApiError)) throw new Error("no SlackApiError");
  for (const value of [INPUT.clientSecret, INPUT.code]) {
    expect(error.message).not.toContain(value);
    expect(error.code).not.toContain(value);
  }
  return {
    method: error.method,
    failure: error.failure,
    httpStatus: error.httpStatus,
    code: error.code,
    answered: error.answered,
  };
}

describe("how an oauth.v2.access call failed", () => {
  test("no answer is unreachable, with no status", async () => {
    expect(
      await failureOf(() => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({
      method: "oauth.v2.access",
      failure: "unreachable",
      httpStatus: null,
      code: "unreachable",
      answered: false,
    });
  });

  test("a non-JSON 5xx is http_status with that status", async () => {
    expect(
      await failureOf(
        () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      ),
    ).toMatchObject({
      failure: "http_status",
      httpStatus: 502,
      code: "http_502",
      answered: false,
    });
  });

  test("ok:false is Slack's error code, answered unless the status is 5xx", async () => {
    expect(
      await failureOf(() =>
        Response.json({ ok: false, error: "invalid_code" }),
      ),
    ).toMatchObject({
      failure: "slack_error",
      httpStatus: 200,
      code: "invalid_code",
      answered: true,
    });
    expect(
      await failureOf(() =>
        Response.json({ ok: false, error: "internal_error" }, { status: 503 }),
      ),
    ).toMatchObject({
      failure: "slack_error",
      httpStatus: 503,
      code: "internal_error",
      answered: false,
    });
  });

  test("Slack's own error is slack_error even when it reads like one of ours", async () => {
    for (const reserved of ["timeout", "unreachable", "unexpected_answer"]) {
      expect(
        await failureOf(() => Response.json({ ok: false, error: reserved })),
      ).toMatchObject({ failure: "slack_error", code: reserved });
    }
  });

  test("ok:false with no readable error is http_status", async () => {
    expect(
      await failureOf(() =>
        Response.json({ ok: false, error: "Not A Code" }, { status: 503 }),
      ),
    ).toMatchObject({
      failure: "http_status",
      httpStatus: 503,
      code: "http_503",
      answered: false,
    });
  });

  test("a 429 is Slack's ratelimited, answered", async () => {
    expect(
      await failureOf(
        () =>
          new Response(null, { status: 429, headers: { "Retry-After": "3" } }),
      ),
    ).toMatchObject({
      failure: "slack_error",
      httpStatus: 429,
      code: "ratelimited",
      answered: true,
    });
  });

  test("the bot check names auth.test when it fails", async () => {
    expect(
      await failureOf(
        () => new Response("<html>", { status: 502 }),
        (api) => api.botIdentity(INPUT.code),
      ),
    ).toMatchObject({
      method: "auth.test",
      failure: "http_status",
      httpStatus: 502,
    });
  });

  test("bots.info is named when auth.test passed and it failed", async () => {
    const answers = [
      Response.json({
        ok: true,
        team_id: "T0TEAM",
        user_id: "U0BOT",
        bot_id: "B0BOT",
      }),
      Response.json({ ok: false, error: "bot_not_found" }),
    ];
    expect(
      await failureOf(
        () => answers.shift() ?? new Response(null, { status: 500 }),
        (api) => api.botIdentity(INPUT.code),
      ),
    ).toMatchObject({
      method: "bots.info",
      failure: "slack_error",
      httpStatus: 200,
      code: "bot_not_found",
    });
  });

  test("a body that times out after the headers is a timeout with the status", async () => {
    const stalled = new ReadableStream({
      pull(controller) {
        controller.error(new DOMException("timed out", "TimeoutError"));
      },
    });
    expect(
      await failureOf(() => new Response(stalled, { status: 200 })),
    ).toMatchObject({
      failure: "timeout",
      httpStatus: 200,
      code: "timeout",
      answered: false,
    });
  });

  test("invalid_manifest keeps Slack's errors array as message and pointer lines, nothing else of the body", async () => {
    const leaked = ["fixture", "leaked", "value"].join("-");
    const api = createSlackConfigApi({
      apiUrl: "http://slack.invalid/api",
      fetch: (async () =>
        Response.json({
          ok: false,
          error: "invalid_manifest",
          errors: [
            {
              message: "The description cannot be empty",
              pointer: "/features/agent_view/agent_description",
              extra: leaked,
            },
            { message: 7 },
          ],
          credentials: { client_secret: leaked },
        })) as unknown as typeof fetch,
    });
    const error = await api.createApp(["fixture", "token"].join("-"), {}).then(
      () => null,
      (caught: unknown) => caught,
    );
    if (!(error instanceof SlackApiError)) throw new Error("no SlackApiError");
    expect(error.code).toBe("invalid_manifest");
    expect(error.details).toEqual([
      "/features/agent_view/agent_description: The description cannot be empty",
    ]);
    expect(JSON.stringify(error.details)).not.toContain(leaked);
  });

  test("the errors lines are bounded in count and length, and a missing pointer leaves the bare message", async () => {
    const api = createSlackConfigApi({
      apiUrl: "http://slack.invalid/api",
      fetch: (async () =>
        Response.json({
          ok: false,
          error: "invalid_manifest",
          errors: [
            { message: "m".repeat(500) },
            ...Array.from({ length: 20 }, () => ({ message: "again" })),
          ],
        })) as unknown as typeof fetch,
    });
    const error = await api.createApp("fixture-token", {}).then(
      () => null,
      (caught: unknown) => caught,
    );
    if (!(error instanceof SlackApiError)) throw new Error("no SlackApiError");
    expect(error.details).toHaveLength(10);
    expect(error.details[0]).toBe("m".repeat(300));
    expect(error.details[1]).toBe("again");
  });

  test("an ok:true answer that does not parse is unexpected_answer, without its body", async () => {
    expect(
      await failureOf(() =>
        Response.json({
          ok: true,
          access_token: INPUT.code,
          token_type: "user",
          scope: "",
          app_id: "A0APP",
        }),
      ),
    ).toEqual({
      method: "oauth.v2.access",
      failure: "unexpected_answer",
      httpStatus: 200,
      code: "unexpected_answer",
      answered: false,
    });
  });
});
