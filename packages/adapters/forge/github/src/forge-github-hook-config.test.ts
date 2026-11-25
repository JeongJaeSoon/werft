import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createGitHubAppHookConfig } from "./forge-github.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

const seen: Array<{
  method: string;
  path: string;
  body: unknown;
  jwt: boolean;
}> = [];
let status = 200;
const github = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    seen.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: await request.json().catch(() => null),
      jwt: /^bearer \S+\.\S+\.\S+$/i.test(
        request.headers.get("authorization") ?? "",
      ),
    });
    return Response.json({ message: "answer" }, { status });
  },
});
afterAll(() => github.stop(true));

describe("createGitHubAppHookConfig", () => {
  const setHook = createGitHubAppHookConfig({ retryAfterBaseMs: 1 });
  const app = {
    appId: 101,
    apiBase: `http://127.0.0.1:${github.port}`,
    privateKey,
  };

  test("patches the App's own hook config at its API base with the URL as the body", async () => {
    seen.length = 0;
    status = 200;
    expect(
      await setHook(app, "https://hooks.example.test/v1/github/webhook"),
    ).toBe("updated");
    expect(seen).toEqual([
      {
        method: "PATCH",
        path: "/app/hook/config",
        body: { url: "https://hooks.example.test/v1/github/webhook" },
        jwt: true,
      },
    ]);
  });

  test("names GitHub's refusal: the App, the URL, or no answer", async () => {
    const outcomes: Record<number, string> = {};
    for (const code of [401, 404, 422, 500]) {
      status = code;
      outcomes[code] = await setHook(
        app,
        "https://hooks.example.test/v1/github/webhook",
      );
    }
    expect(outcomes).toEqual({
      401: "github_rejected",
      404: "github_rejected",
      422: "url_refused",
      500: "github_unreachable",
    });
  });
});
