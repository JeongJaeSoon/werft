import { describe, expect, test } from "bun:test";
import {
  githubWebhookResponseSchema,
  REQUEST_BODY_MAX_BYTES,
} from "@werft-ai/contracts";
import type { SkillGitSync } from "@werft-ai/platform";
import { createSlackEventsLimiter } from "../../rate-limit.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import {
  githubWebhookUrlFrom,
  registerGitHubWebhookRoutes,
} from "./github-webhook.ts";

const createApiApp = recordRouteErrors("routes/github/github-webhook.test.ts");

type Received = Parameters<SkillGitSync["receive"]>[0];

function appWith(
  answer: "accepted" | "unauthorized",
  limits?: Parameters<typeof createSlackEventsLimiter>[0],
) {
  const received: Received[] = [];
  const app = createApiApp({
    authMode: "api-key",
    registerPublicRoutes: (router) =>
      registerGitHubWebhookRoutes(router, {
        sync: {
          receive: async (input: Received) => {
            received.push(input);
            return answer;
          },
        } as unknown as SkillGitSync,
        limiter: createSlackEventsLimiter(limits),
      }),
  });
  const deliver = (body: string, headers: Record<string, string> = {}) =>
    app.request("/v1/github/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Hook-Installation-Target-ID": "1234",
        "X-GitHub-Event": "push",
        "X-GitHub-Delivery": "d-1",
        "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
        ...headers,
      },
      body,
    });
  return { received, deliver };
}

describe("the GitHub webhook route", () => {
  test("hands the raw body and the four headers over, and answers 202 without a credential", async () => {
    const { received, deliver } = appWith("accepted");
    const body = '{"ref":"refs/heads/main"}';
    const response = await deliver(body);
    expect(response.status).toBe(202);
    expect(githubWebhookResponseSchema.parse(await response.json())).toEqual({
      accepted: true,
    });
    expect(received).toHaveLength(1);
    const [one] = received;
    expect(new TextDecoder().decode(one?.body)).toBe(body);
    expect({ ...one, body: undefined }).toEqual({
      appId: "1234",
      event: "push",
      deliveryId: "d-1",
      signature: `sha256=${"0".repeat(64)}`,
      body: undefined,
    });
  });

  test("a delivery no stored secret verifies is 401", async () => {
    const { deliver } = appWith("unauthorized");
    expect((await deliver("{}")).status).toBe(401);
  });

  test("a body over 64 KiB is 413 before anything reads it", async () => {
    const { received, deliver } = appWith("accepted");
    const response = await deliver(
      JSON.stringify({ pad: "x".repeat(REQUEST_BODY_MAX_BYTES) }),
    );
    expect(response.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  test("past the per-App rate it is 429 before anything reads it", async () => {
    const { received, deliver } = appWith("accepted", { agentPerMinute: 1 });
    expect((await deliver("{}")).status).toBe(202);
    const limited = await deliver("{}");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).not.toBeNull();
    expect(received).toHaveLength(1);
  });
});

describe("GITHUB_WEBHOOK_BASE_URL", () => {
  test("unset is no webhook; an https base keeps its path prefix", () => {
    expect(githubWebhookUrlFrom({})).toBeNull();
    expect(githubWebhookUrlFrom({ GITHUB_WEBHOOK_BASE_URL: "" })).toBeNull();
    expect(
      githubWebhookUrlFrom({
        GITHUB_WEBHOOK_BASE_URL: "https://werft.example.com/",
      }),
    ).toBe("https://werft.example.com/v1/github/webhook");
    expect(
      githubWebhookUrlFrom({
        GITHUB_WEBHOOK_BASE_URL: "https://edge.example.com/werft",
      }),
    ).toBe("https://edge.example.com/werft/v1/github/webhook");
  });

  test("anything but a plain https URL stops the start", () => {
    for (const value of [
      "werft.example.com",
      "http://werft.example.com",
      "https://werft.example.com/?a=1",
      "https://werft.example.com/#x",
      "https://user@werft.example.com",
    ]) {
      expect(() =>
        githubWebhookUrlFrom({ GITHUB_WEBHOOK_BASE_URL: value }),
      ).toThrow("GITHUB_WEBHOOK_BASE_URL");
    }
  });
});
