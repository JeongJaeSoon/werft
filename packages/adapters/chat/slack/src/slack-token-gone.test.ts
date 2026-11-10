import { describe, expect, test } from "bun:test";
import type { AgentIdentityRecord } from "@werft-ai/platform";
import { SlackApiError } from "./slack-config-api.ts";
import {
  createSlackTokenRevoked,
  isTokenGone,
  isTokenRevoked,
} from "./slack-token-gone.ts";
import { createMemorySecretStore } from "./testing/slack-fakes.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const SLACK_APP = "019a0000-0000-7000-8000-0000000000d1";
const SINCE = new Date("2026-11-05T01:00:00.000Z");

const identity = (
  status: AgentIdentityRecord["status"],
  teamId: string,
): AgentIdentityRecord => ({
  id: crypto.randomUUID(),
  workspaceId: WORKSPACE,
  agentId: AGENT,
  provider: "slack_bot",
  installationId: crypto.randomUUID(),
  appId: "A0APP",
  teamId,
  externalPrincipalId: "U0BOT",
  credentialRef: "slack/ref",
  status,
  revision: 1,
  createdBy: null,
  createdAt: SINCE,
  revokedAt: null,
});

function world(rows: AgentIdentityRecord[], stored: string | null) {
  const secrets = createMemorySecretStore();
  if (stored !== null) {
    secrets.write(
      {
        workspaceId: WORKSPACE,
        owner: { kind: "slack_app", id: SLACK_APP },
        purpose: "slack_bot_token",
      },
      stored,
    );
  }
  const revoked: { key: unknown; sentAt: Date | null | undefined }[] = [];
  const errors: unknown[] = [];
  const run = createSlackTokenRevoked({
    identities: { list: async () => rows },
    installs: {
      revokeInstallation: async (key, sentAt) => {
        revoked.push({ key, sentAt });
        return "revoked";
      },
    },
    secrets: secrets.store,
    onError: (error) => errors.push(error),
  });
  const call = (failedToken: string) =>
    run({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      slackAppId: SLACK_APP,
      appId: "A0APP",
      failedToken,
      since: SINCE,
    });
  return { call, revoked, errors };
}

describe("Slack answered that the bot token is gone", () => {
  test("only an answered dead-token code counts, and only two of them revoke", () => {
    const answered = (code: string) =>
      new SlackApiError("auth.test", code, true);
    expect(
      ["invalid_auth", "token_expired", "token_revoked"].map((code) =>
        isTokenGone(answered(code)),
      ),
    ).toEqual([true, true, true]);
    expect(isTokenGone(answered("channel_not_found"))).toBe(false);
    expect(
      isTokenGone(new SlackApiError("auth.test", "token_revoked", false)),
    ).toBe(false);
    expect(isTokenGone(new Error("token_revoked"))).toBe(false);
    expect(
      ["token_revoked", "account_inactive"].map((code) =>
        isTokenRevoked(answered(code)),
      ),
    ).toEqual([true, true]);
    expect(
      ["invalid_auth", "not_authed", "token_expired"].map((code) =>
        isTokenRevoked(answered(code)),
      ),
    ).toEqual([false, false, false]);
  });

  test("revokes the failed app's active install, skipping one verified since the call began", async () => {
    const { call, revoked } = world(
      [identity("revoked", "T0OLD"), identity("active", "T0LIVE")],
      "xoxb-failed",
    );
    await call("xoxb-failed");
    expect(revoked).toEqual([
      {
        key: { appId: "A0APP", teamId: "T0LIVE" },
        sentAt: new Date(SINCE.getTime() - 1000),
      },
    ]);
  });

  test("leaves the agent's installs of other apps alone", async () => {
    const other = { ...identity("active", "T0OTHER"), appId: "A0OTHER" };
    const { call, revoked } = world(
      [other, identity("active", "T0LIVE")],
      "xoxb-failed",
    );
    await call("xoxb-failed");
    expect(revoked.map((row) => row.key)).toEqual([
      { appId: "A0APP", teamId: "T0LIVE" },
    ]);
  });

  test("leaves it when a reinstall already stored another token", async () => {
    const { call, revoked } = world([identity("active", "T0")], "xoxb-new");
    await call("xoxb-failed");
    expect(revoked).toEqual([]);
  });

  test("leaves it when the token is gone from the store or no identity is active", async () => {
    const gone = world([identity("active", "T0")], null);
    await gone.call("xoxb-failed");
    const none = world([identity("revoked", "T0")], "xoxb-failed");
    await none.call("xoxb-failed");
    expect([gone.revoked, none.revoked]).toEqual([[], []]);
  });

  test("a failing store is reported, never thrown at the caller", async () => {
    const boom = new Error("db down");
    const errors: unknown[] = [];
    const run = createSlackTokenRevoked({
      identities: {
        list: async () => {
          throw boom;
        },
      },
      installs: { revokeInstallation: async () => "revoked" },
      secrets: { get: async () => "xoxb-failed" },
      onError: (error) => errors.push(error),
    });
    await run({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      slackAppId: SLACK_APP,
      appId: "A0APP",
      failedToken: "xoxb-failed",
      since: SINCE,
    });
    expect(errors).toEqual([boom]);
  });
});
