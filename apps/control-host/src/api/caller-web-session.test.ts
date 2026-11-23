import { describe, expect, test } from "bun:test";
import { fakeWebSessions } from "../testing/web-session.ts";
import { createApiApp } from "./app.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000c1";
const { sessions, cookieFor, identity, keyStore, key } =
  fakeWebSessions(WORKSPACE);

// 94S-1945: a turn records the console login it came in on, so the caller
// the cookie path assembles carries it; a key's caller carries none.
function app() {
  return createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) => {
      router.get("/caller-probe", (context) =>
        context.json({
          webSessionId: context.get("caller").actor?.webSessionId ?? null,
        }),
      );
    },
  });
}

describe("the caller's web session", () => {
  test("the cookie path names the login; a key names none", async () => {
    const cookie = cookieFor("member");
    const [login] = [...sessions.values()];
    const byCookie = await app().request("/v1/caller-probe", {
      headers: { Cookie: cookie },
    });
    expect(byCookie.status).toBe(200);
    expect(await byCookie.json()).toEqual({ webSessionId: login?.sessionId });
    const byKey = await app().request("/v1/caller-probe", {
      headers: { Authorization: `Bearer ${key.plaintext}` },
    });
    expect(byKey.status).toBe(200);
    expect(await byKey.json()).toEqual({ webSessionId: null });
  });
});
