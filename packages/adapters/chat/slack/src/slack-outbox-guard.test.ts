import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SurfaceOutboxClaim } from "@werft-ai/platform";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import { createRowDelivery } from "./outbox-delivery.ts";
import { createSlackBotApi } from "./slack-config-api.ts";
import {
  dropOutOfScopeSlackRefs,
  guardSlackOutboxBody,
  slackOutboxScope,
  slackOutboxText,
  stripSlackGroupMentions,
} from "./slack-outbox-render.ts";

// v2.4 9-1 G7 and A3: what the outbox sends names no group, and links or
// names no Slack channel outside the conversation it speaks in.

const TEAM = "T08TEAM111";
const HERE = "C08HERE111";
const ELSEWHERE = "C08AWAY222";
const SCOPE = { teamId: TEAM, channelId: HERE };
const here = `https://acme.slack.com/archives/${HERE}/p1700000000000100`;
const away = `https://acme.slack.com/archives/${ELSEWHERE}/p1700000000000200`;

describe("stripSlackGroupMentions", () => {
  test.each([
    ["<!here> look", "look"],
    ["look <!channel>", "look"],
    ["a <!everyone> b", "a b"],
    ["a <!here|here> b", "a b"],
    ["ask <!subteam^S0ONCALL|@oncall> now", "ask now"],
    ["ask <!subteam^S0ONCALL> now", "ask now"],
    ["@here look", "look"],
    ["hey @channel, look", "hey, look"],
    ["a @everyone b", "a b"],
    ["ping _@channel_ now", "ping __ now"],
  ])("%p loses its group mention", (text, posted) => {
    expect(stripSlackGroupMentions(text)).toBe(posted);
  });

  test("keeps a person's mention, an address and mentions in code", () => {
    const text =
      "<@U0ADA> wrote to ops@here.example: `@here <!here>` and ```\n@channel\n```";
    expect(stripSlackGroupMentions(text)).toBe(text);
  });
});

describe("dropOutOfScopeSlackRefs", () => {
  test("keeps the conversation's own channel", () => {
    const text = `see ${here}, <${here}|this>, [this](${here}), <#${HERE}> and ${HERE}`;
    expect(dropOutOfScopeSlackRefs(text, SCOPE)).toEqual({ text, dropped: [] });
  });

  test.each([
    [`see ${away}.`, "see ."],
    [`see <${away}|that thread>`, "see "],
    [`see [that](${away})`, "see "],
    [`see <#${ELSEWHERE}|ops>`, "see "],
    [`see ${ELSEWHERE}`, "see "],
    [`see https://app.slack.com/client/T09OTHER22/${HERE}`, "see "],
    [`see slack://channel?team=${TEAM}&id=${ELSEWHERE}`, "see "],
  ])("%p loses the piece outside", (text, posted) => {
    const result = dropOutOfScopeSlackRefs(text, SCOPE);
    expect(result.text).toBe(posted);
    expect(result.dropped.length).toBeGreaterThan(0);
  });

  test.each([
    // A label of its own, Markdown or Slack's.
    [`see [${ELSEWHERE}](https://example.com)`, "see "],
    [`see <https://example.com|${away}>`, "see "],
    // The same channel, encoded or in lower case.
    [`see https://acme.slack.com/archives/%4308AWAY222/p1`, "see "],
    [`see https://acme.slack.com/archives/${ELSEWHERE.toLowerCase()}`, "see "],
    [`see acme.slack.com/archives/%4308AWAY222`, "see "],
    [`see HTTPS://ACME.SLACK.COM/archives/%4308AWAY222`, "see "],
    // In a link's fragment, on any site.
    [`see https://example.com/#${ELSEWHERE}`, "see "],
    [`see ${here}#${ELSEWHERE}`, "see "],
    // In a URL that does not parse.
    [`see https://acme.slack.com:bad/archives/${ELSEWHERE}`, "see "],
    // Set off by underscores (italics), or past a malformed escape.
    [`see _${ELSEWHERE}_`, "see __"],
    [`see ${here}?x=%ZZ#%4308AWAY222`, "see "],
    // An id in brackets of its own.
    [`see <${ELSEWHERE}>`, "see "],
    // Another site's link that carries the id.
    [`see https://example.com/${ELSEWHERE}`, "see "],
  ])("%p loses the piece written another way", (text, posted) => {
    const result = dropOutOfScopeSlackRefs(text, SCOPE);
    expect(result.text).toBe(posted);
    expect(result.dropped).toEqual([ELSEWHERE]);
  });

  test("keeps links that name no channel, and other sites", () => {
    const text =
      "https://api.slack.com/methods/chat.postMessage and https://github.com/acme/C08AWAY222x";
    expect(dropOutOfScopeSlackRefs(text, SCOPE).text).toBe(text);
  });

  test("with no scope every Slack channel is outside", () => {
    expect(dropOutOfScopeSlackRefs(`a ${here} b`, null)).toEqual({
      text: "a  b",
      dropped: [HERE],
    });
  });
});

function claim(over: Partial<SurfaceOutboxClaim> = {}): SurfaceOutboxClaim {
  return {
    id: "row-1",
    claimToken: "fence-1",
    attempts: 1,
    workspaceId: "ws-1",
    agentId: "agent-1",
    slackAppId: SLACK_APP,
    installationId: "installation-1",
    kind: "reply",
    channelId: HERE,
    threadTs: "1700000000.000100",
    slackUserId: null,
    sessionId: "session-1",
    sessionLinkId: null,
    body: { text: "Done." },
    dedupeKey: "reply:1",
    conversationScope: { kind: "channel", teamId: TEAM, channelId: HERE },
    ...over,
  };
}

describe("slackOutboxScope", () => {
  test("a DM's scope is the row's own DM channel", () => {
    const dm = { kind: "dm" as const, teamId: TEAM, channelId: null };
    expect(
      slackOutboxScope({ channelId: "D08DM00001", conversationScope: dm }),
    ).toEqual({ teamId: TEAM, channelId: "D08DM00001" });
    expect(
      slackOutboxScope({ channelId: "U08ADA0001", conversationScope: dm }),
    ).toBeNull();
    expect(
      slackOutboxScope({ channelId: HERE, conversationScope: null }),
    ).toBeNull();
  });
});

describe("guardSlackOutboxBody", () => {
  test("a person's instruction loses its group mentions only", () => {
    for (const kind of ["instruction", "input_mirror"] as const) {
      const body = {
        text: `<!here> see ${away}`,
        sender: { username: "Ada (web)" },
      };
      expect(guardSlackOutboxBody(claim({ kind, body }))).toEqual({
        body: { ...body, text: `see ${away}` },
        dropped: [],
      });
    }
  });

  test.each([
    [`@cha[x](${away})nnel look`, "look"],
    ["@cha<!here>nnel look", "look"],
    [`C08AW<!here>AY222 look`, " look"],
  ])("%p: what one removal joins, the next takes", (text, posted) => {
    expect(guardSlackOutboxBody(claim({ body: { text } })).body.text).toBe(
      posted,
    );
  });

  test("a card's own blocks and text go as they are", () => {
    const body = { text: `<!here> ${away}`, blocks: [{ type: "divider" }] };
    expect(
      guardSlackOutboxBody(claim({ kind: "input_notice", body })).body,
    ).toBe(body);
  });
});

const BOT = "bot-guard";
const SLACK_APP = "slack-app-guard";
const fakeSlack = startFakeSlackApi();
beforeAll(() => {
  fakeSlack.apps.set(SLACK_APP, {
    appId: SLACK_APP,
    clientId: "client",
    clientSecret: "client-secret",
    signingSecret: "signing-secret",
    manifest: null,
    botTokens: [BOT],
  });
});
afterAll(() => fakeSlack.stop());

async function send(row: SurfaceOutboxClaim) {
  fakeSlack.messages.length = 0;
  const warned: {
    message: string;
    fields: Record<string, unknown> | undefined;
  }[] = [];
  const delivery = createRowDelivery({
    slack: createSlackBotApi({ apiUrl: fakeSlack.url }),
    botToken: async () => BOT,
    consoleOrigin: null,
    logger: { warn: (message, fields) => warned.push({ message, fields }) },
  });
  const outcome = await delivery.direct({
    row,
    attempts: row.attempts,
    begin: async () => true,
  });
  return { outcome, posted: fakeSlack.messages.map((m) => m.text), warned };
}

describe("the outbox sends the guarded text", () => {
  test("a reply reaches Slack without group mentions or another channel", async () => {
    const { outcome, posted, warned } = await send(
      claim({
        body: {
          text: `<!channel> Done <@U0ADA>: ${here} and <${away}|the other one>`,
          mention_user_ids: ["U0ADA"],
        },
      }),
    );
    expect(outcome.kind).toBe("sent");
    expect(posted).toEqual([`Done <@U0ADA>: ${here} and `]);
    expect(warned).toEqual([
      {
        message: "Slack send dropped references outside its conversation",
        fields: {
          id: "row-1",
          kind: "reply",
          channel_id: HERE,
          session_id: "session-1",
          dropped: [ELSEWHERE],
        },
      },
    ]);
  });

  test("a reply of its own channel only goes as it is, unlogged", async () => {
    const text = `Done: ${here}`;
    const { posted, warned } = await send(claim({ body: { text } }));
    expect(posted).toEqual([slackOutboxText({ text })]);
    expect(warned).toEqual([]);
  });

  test("what the Markdown render joins is guarded too", async () => {
    const away = "# C08AW**AY**222 @cha**nn**el";
    const { posted, warned } = await send(claim({ body: { text: away } }));
    expect(posted.join("")).not.toContain(ELSEWHERE);
    expect(posted.join("")).not.toContain("@channel");
    expect(warned[0]?.fields?.dropped).toEqual([ELSEWHERE]);
    const table = "| a |\n| --- |\n| # @cha**nn**el |";
    await send(claim({ body: { text: table } }));
    expect(JSON.stringify(fakeSlack.messages)).not.toContain("@channel");
  });

  test("a reply the guard empties still says it is done", async () => {
    for (const text of ["<!here>", ELSEWHERE, "# @cha**nn**el"]) {
      const { outcome, posted } = await send(
        claim({ body: { text, locale: "en" } }),
      );
      expect(outcome.kind).toBe("sent");
      expect(posted).toEqual(["The answer is done. See it on the web"]);
    }
  });

  test("a reply of marks alone that the guard left whole goes as it is", async () => {
    for (const text of ["`||`", "`*`", "---"]) {
      const { posted } = await send(claim({ body: { text, locale: "en" } }));
      expect(posted).toEqual([slackOutboxText({ text, locale: "en" })]);
    }
  });

  test("a table reply's blocks are guarded too", async () => {
    const text = `<!here> ${away}\n\n| a | b |\n| --- | --- |\n| 1 | 2 |`;
    await send(claim({ body: { text } }));
    const sent = JSON.stringify(fakeSlack.messages);
    expect(sent).not.toContain("!here");
    expect(sent).not.toContain(ELSEWHERE);
  });
});
