import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  openSecret,
  type SecretAadFields,
  SecretKey,
  type SecretOwnerRef,
  sealSecret,
} from "@werft-ai/platform";
import { createSlackBotApi } from "../wiring/chat-slack.ts";
import {
  PRIVATE_CHANNEL_SESSIONS_EXIT,
  PrivateChannelSessionsUsageError,
  parsePrivateChannelSessionsCommand,
  runPrivateChannelSessions,
  slackOfAgents,
} from "./private-channel-sessions.ts";

const WORKSPACE = "019A0000-0000-7000-8000-0000000000F1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";

describe("parsePrivateChannelSessionsCommand", () => {
  test("plan and apply, for everything, a workspace or an agent", () => {
    expect(parsePrivateChannelSessionsCommand(["plan"])).toEqual({
      command: "plan",
      filter: {},
    });
    expect(
      parsePrivateChannelSessionsCommand(["apply", "--workspace", WORKSPACE]),
    ).toEqual({
      command: "apply",
      filter: { workspaceId: WORKSPACE.toLowerCase() },
    });
    expect(
      parsePrivateChannelSessionsCommand(["plan", "--agent", AGENT]),
    ).toEqual({ command: "plan", filter: { agentId: AGENT } });
  });

  test.each([
    [[]],
    [["move"]],
    [["plan", "extra"]],
    [["plan", "--workspace", WORKSPACE, "--agent", AGENT]],
    [["plan", "--agent", "not-a-uuid"]],
    [["plan", "--agent"]],
    [["plan", "--dry-run"]],
  ])("%j is a usage error", (argv) => {
    expect(() => parsePrivateChannelSessionsCommand(argv)).toThrow(
      PrivateChannelSessionsUsageError,
    );
  });
});

describe("runPrivateChannelSessions", () => {
  const io = (env: Record<string, string | undefined>) => {
    const err: string[] = [];
    let opened = 0;
    return {
      err,
      opened: () => opened,
      io: {
        env,
        out: () => {},
        err: (line: string) => err.push(line),
        loadKey: async () => null,
        openDatabase: async () => {
          opened += 1;
          throw new Error("not reached");
        },
      },
    };
  };

  test("without DATABASE_URL or the master key it stops before the database", async () => {
    const none = io({});
    expect(await runPrivateChannelSessions(["plan"], none.io)).toBe(
      PRIVATE_CHANNEL_SESSIONS_EXIT.usage,
    );
    expect(none.err[0]).toContain("DATABASE_URL is required");
    const keyless = io({ DATABASE_URL: "postgres://db.invalid/werft" });
    expect(await runPrivateChannelSessions(["apply"], keyless.io)).toBe(
      PRIVATE_CHANNEL_SESSIONS_EXIT.usage,
    );
    expect(keyless.err[0]).toContain("master_key_missing");
    expect(keyless.opened()).toBe(0);
  });
});

describe("slackOfAgents", () => {
  const APP = "019a0000-0000-7000-8000-0000000000b1";
  const place = {
    workspaceId: WORKSPACE.toLowerCase(),
    agentId: AGENT,
    installationId: "019a0000-0000-7000-8000-0000000000c1",
    teamId: "T0TEAM",
    channelId: "C0CHANNEL",
  };
  const fields: SecretAadFields = {
    id: "019a0000-0000-7000-8000-0000000000e1",
    workspaceId: place.workspaceId,
    ownerRef: `slack_app:${APP}` as SecretOwnerRef,
    purpose: "slack_bot_token",
    secretVersion: 1,
    keyVersion: 1,
  };
  const newKey = () =>
    SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST");
  const app = async () => ({ id: APP }) as never;
  // Never reached: each case ends before there is anything to ask Slack with.
  const api = {} as Parameters<typeof slackOfAgents>[0]["api"];

  test("a bot credential sealed under another key leaves the channel unread as master_key_mismatch", async () => {
    const sealed = sealSecret(newKey(), fields, "sealed by the API");
    // The command's own key, which is not the one the API sealed with.
    const commandKey = newKey();
    const slack = slackOfAgents({
      apps: { findForAgent: app },
      secrets: { get: async () => openSecret(commandKey, fields, sealed) },
      api,
    });
    expect(await slack.kindOf(place)).toEqual({
      unconfirmed: "master_key_mismatch",
    });
  });

  test("an agent with no app is SLACK_NOT_INSTALLED, and an error without a code stays failed", async () => {
    const none = slackOfAgents({
      apps: { findForAgent: async () => null },
      secrets: { get: async () => null },
      api,
    });
    expect(await none.kindOf(place)).toEqual({
      unconfirmed: "SLACK_NOT_INSTALLED",
    });
    const broken = slackOfAgents({
      apps: { findForAgent: app },
      secrets: {
        get: async () => {
          throw new Error("the database went away");
        },
      },
      api,
    });
    expect(await broken.kindOf(place)).toEqual({ unconfirmed: "failed" });
  });

  describe("memberIds says why the list went unread", () => {
    const readable = (fetchImpl: typeof fetch) => {
      const commandKey = newKey();
      const sealed = sealSecret(commandKey, fields, "bot-token-for-test");
      return slackOfAgents({
        apps: { findForAgent: app },
        secrets: { get: async () => openSecret(commandKey, fields, sealed) },
        api: createSlackBotApi({ fetch: fetchImpl }),
      });
    };
    const answer = (body: unknown, status = 200) =>
      (async () => Response.json(body, { status })) as unknown as typeof fetch;

    test("a Slack error answer gives its code", async () => {
      const slack = readable(answer({ ok: false, error: "missing_scope" }));
      expect(await slack.memberIds(place)).toEqual({
        unconfirmed: "slack_error:missing_scope",
      });
    });

    test("rate limiting, an HTTP failure and no answer are told apart", async () => {
      expect(
        await readable(answer({}, 429)).memberIds(place),
      ).toEqual({ unconfirmed: "slack_error:ratelimited" });
      expect(
        await readable(answer("<html>", 502)).memberIds(place),
      ).toEqual({ unconfirmed: "http_502" });
      const down = (async () => {
        throw new TypeError("connect ECONNREFUSED with the token in it");
      }) as unknown as typeof fetch;
      expect(await readable(down).memberIds(place)).toEqual({
        unconfirmed: "unreachable",
      });
    });

    test("more than 10,000 members is too_many_members, after following every cursor", async () => {
      let pages = 0;
      const ids = (page: number) =>
        Array.from({ length: 1000 }, (_, n) => `U${page * 1000 + n}`);
      const many = (async () => {
        const page = pages;
        pages += 1;
        return Response.json({
          ok: true,
          members: ids(page),
          response_metadata: { next_cursor: `c${page}` },
        });
      }) as unknown as typeof fetch;
      expect(await readable(many).memberIds(place)).toEqual({
        unconfirmed: "too_many_members",
      });
      expect(pages).toBe(11);
    });

    test("any other error leaves only its name", async () => {
      const key = newKey();
      const sealed = sealSecret(key, fields, "bot-token-for-test");
      const again = slackOfAgents({
        apps: { findForAgent: app },
        secrets: { get: async () => openSecret(key, fields, sealed) },
        api: {
          channelMembers: async () => {
            throw new RangeError("sk-secret-in-the-message");
          },
        } as never,
      });
      expect(await again.memberIds(place)).toEqual({
        unconfirmed: "exception:RangeError",
      });
    });
  });
});
