import { describe, expect, test } from "bun:test";
import { scopesForRole } from "@werft-ai/contracts";
import { callerFor } from "@werft-ai/platform";
import { refusal } from "@werft-ai/platform/testing/refusal";
import { SLACK_HTTP_TIMEOUT_MS, SlackApiError } from "./slack-config-api.ts";
import {
  CONFIG_TOKEN_LEASE_MS,
  CONFIG_TOKEN_REFRESH_MARGIN_MS,
  createSlackConfigTokens,
} from "./slack-config-token.ts";
import {
  createFakeSlackConfigApi,
  createMemoryConfigTokenStore,
  createMemorySecretStore,
} from "./testing/slack-fakes.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";
const HOUR = 3600_000;

const owner = callerFor(
  {
    kind: "user",
    id: OWNER,
    workspace_id: WORKSPACE,
    role: "owner",
    scopes: [...scopesForRole("owner")],
  },
  { kind: "web" },
  crypto.randomUUID(),
);
const audit = () => ({
  principal: owner,
  receiptId: crypto.randomUUID(),
  roles: ["owner", "admin"] as const,
});

function setup() {
  let clock = new Date("2026-10-23T00:00:00.000Z");
  const secrets = createMemorySecretStore();
  const memory = createMemoryConfigTokenStore(secrets);
  const slack = createFakeSlackConfigApi({ now: () => clock });
  const tokens = createSlackConfigTokens({
    store: memory.store,
    api: slack.api,
    now: () => clock,
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock = new Date(clock.getTime() + ms);
    },
  });
  const rotations = () =>
    slack.state.calls.filter((call) => call.method === "tooling.tokens.rotate")
      .length;
  return {
    tokens,
    memory,
    secrets,
    slack,
    rotations,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe("Slack config token rotation", () => {
  test("saving rotates at once and keeps the new pair, not the pasted one", async () => {
    const { tokens, memory, slack, rotations } = setup();
    const pasted = slack.issueRefresh();
    const stored = await tokens.register(WORKSPACE, pasted, audit());
    expect(stored).toMatchObject({
      outcome: "stored",
      summary: { state: "active", issuer: { userId: "U0ISSUER" } },
    });
    expect(rotations()).toBe(1);
    const pair = memory.pair(WORKSPACE);
    expect(pair?.refresh_token).not.toBe(pasted);
    expect(slack.state.refreshTokens.has(pair?.refresh_token ?? "")).toBe(true);
  });

  test("the access token is reused until five minutes before it expires", async () => {
    const { tokens, slack, rotations, advance } = setup();
    await tokens.register(WORKSPACE, slack.issueRefresh(), audit());
    const first = await tokens.accessToken(WORKSPACE);
    advance(12 * HOUR - CONFIG_TOKEN_REFRESH_MARGIN_MS - 1_000);
    expect(await tokens.accessToken(WORKSPACE)).toEqual(first);
    expect(rotations()).toBe(1);
    advance(2_000);
    const second = await tokens.accessToken(WORKSPACE);
    expect(second.token).not.toBe(first.token);
    expect(rotations()).toBe(2);
  });

  test("two callers needing a rotation at once make one Slack call", async () => {
    const { tokens, slack, rotations, advance } = setup();
    await tokens.register(WORKSPACE, slack.issueRefresh(), audit());
    advance(12 * HOUR);
    const [a, b] = await Promise.all([
      tokens.accessToken(WORKSPACE),
      tokens.accessToken(WORKSPACE),
    ]);
    expect(a.token).toBe(b.token);
    expect(rotations()).toBe(2);
  });

  test("a pasted token Slack refuses is 409 rejected and keeps the old pair", async () => {
    const { tokens, memory, slack } = setup();
    await tokens.register(WORKSPACE, slack.issueRefresh(), audit());
    const before = memory.pair(WORKSPACE);
    expect(
      await refusal(tokens.register(WORKSPACE, "not-a-live-token", audit())),
    ).toEqual({
      code: "CONFIG_TOKEN_INVALID",
      details: { reason_code: "rejected" },
    });
    expect(memory.pair(WORKSPACE)).toEqual(before);
    expect((await tokens.describe(WORKSPACE)).state).toBe("active");
  });

  test.each(["invalid_refresh_token", "token_expired", "invalid_auth"])(
    "Slack answering %s to a rotation asks for a new token",
    async (code) => {
      const { tokens, slack, advance } = setup();
      await tokens.register(WORKSPACE, slack.issueRefresh(), audit());
      advance(12 * HOUR);
      slack.state.next.rotate = async () => {
        throw new SlackApiError("tooling.tokens.rotate", code, true);
      };
      expect(await refusal(tokens.accessToken(WORKSPACE))).toEqual({
        code: "CONFIG_TOKEN_INVALID",
        details: { reason_code: "needs_reentry" },
      });
      const summary = await tokens.describe(WORKSPACE);
      expect(summary).toMatchObject({ state: "needs_reentry", secret: null });
    },
  );

  test("Slack answered but the pair could not be written: paste a new token", async () => {
    const { tokens, memory, slack, advance } = setup();
    await tokens.register(WORKSPACE, slack.issueRefresh(), audit());
    advance(12 * HOUR);
    memory.faults.complete = 3;
    expect(await refusal(tokens.accessToken(WORKSPACE))).toEqual({
      code: "CONFIG_TOKEN_INVALID",
      details: { reason_code: "needs_reentry" },
    });
    expect(await tokens.describe(WORKSPACE)).toMatchObject({
      state: "needs_reentry",
      secret: null,
    });
  });

  test("a write that fails once is retried and the new pair kept", async () => {
    const { tokens, memory, slack, advance } = setup();
    await tokens.register(WORKSPACE, slack.issueRefresh(), audit());
    advance(12 * HOUR);
    memory.faults.complete = 2;
    const fresh = await tokens.accessToken(WORKSPACE);
    expect(memory.pair(WORKSPACE)?.access_token).toBe(fresh.token);
  });

  test("a lease left by a rotation that never finished turns into needs_reentry", async () => {
    const { tokens, memory, slack, advance } = setup();
    await tokens.register(WORKSPACE, slack.issueRefresh(), audit());
    advance(12 * HOUR);
    const at = new Date();
    await memory.store.claim(WORKSPACE, {
      now: at,
      freshUntil: at,
      leaseUntil: new Date(0),
    });
    expect(await refusal(tokens.accessToken(WORKSPACE))).toEqual({
      code: "CONFIG_TOKEN_INVALID",
      details: { reason_code: "needs_reentry" },
    });
  });

  test("Slack not answering a rotation frees the lease for the next caller", async () => {
    const { tokens, slack, advance, rotations } = setup();
    await tokens.register(WORKSPACE, slack.issueRefresh(), audit());
    advance(12 * HOUR);
    slack.state.next.rotate = async () => {
      throw new SlackApiError("tooling.tokens.rotate", "timeout", false);
    };
    expect((await refusal(tokens.accessToken(WORKSPACE))).code).toBe(
      "BACKEND_UNAVAILABLE",
    );
    await tokens.accessToken(WORKSPACE);
    expect(rotations()).toBe(3);
  });

  test("an access token Slack calls expired forces a rotation next time", async () => {
    const { tokens, slack, rotations } = setup();
    await tokens.register(WORKSPACE, slack.issueRefresh(), audit());
    expect(
      await refusal(
        tokens.withToken(WORKSPACE, async () => {
          throw new SlackApiError(
            "apps.manifest.create",
            "token_expired",
            true,
          );
        }),
      ),
    ).toEqual({
      code: "CONFIG_TOKEN_INVALID",
      details: { reason_code: "rejected" },
    });
    await tokens.accessToken(WORKSPACE);
    expect(rotations()).toBe(2);
  });

  test("an unset token is 409 not_set", async () => {
    const { tokens } = setup();
    expect(await refusal(tokens.accessToken(WORKSPACE))).toEqual({
      code: "CONFIG_TOKEN_INVALID",
      details: { reason_code: "not_set" },
    });
  });

  test("the lease outlives the Slack call's timeout", () => {
    expect(CONFIG_TOKEN_LEASE_MS).toBeGreaterThan(SLACK_HTTP_TIMEOUT_MS);
  });
});
