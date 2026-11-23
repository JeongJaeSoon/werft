// Runs inside this verification project's API container; never returns credentials.
import { createHmac } from "node:crypto";
import { createSlackSigningSecrets } from "@werft-ai/chat-slack";
import * as schema from "@werft-ai/db";
import {
  createPostgresSecretStore,
  createPostgresSlackAppStore,
} from "@werft-ai/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadSecretKey } from "./apps/control-host/src/api/catalog-config.ts";

const [agentId, mode, channel = "C0VERIFY", seq = "1", parent, text] =
  process.argv.slice(1);
// `mention` and `plain` are top-level posts by U0MOCK in `channel`, with
// or without a mention; each sequence number is its own event and thread.
// `reply` is an unmentioned post in the thread `parent` opened. `plain`
// to a D… channel is U0MOCK's DM to the bot.
// `bot-mention` is the same mention from another app's bot U0REVIEWBOT (seed
// it with /fake/users first); with `parent` it is a reply in that thread.
const botMention = mode === "bot-mention";
// `own-reply` is this app's bot answering in the thread `parent` opened;
// `own-mirror` is the outbox posting an instruction there under its
// sender's name (bot_message, only the app to tell it by). `slackbot` is
// Slackbot's note in the DM `channel` (or a channel).
const echo =
  mode === "own-reply" || mode === "own-mirror" || mode === "slackbot";
const posted =
  mode === "mention" ||
  mode === "plain" ||
  mode === "reply" ||
  botMention ||
  echo;
const uninstalled = mode === "uninstall" || mode === "uninstall-late";
// `join` and `leave` are this app's bot entering or leaving `channel`
// (private by the mock's G prefix, public by C). `leave` is what Slack sends
// the bot itself: `group_left` for a private channel, `channel_left` for a
// public one; `leave-member` is the `member_left_channel` naming the bot.
// `seq` seconds are added to the current time for event_ts, so a higher seq
// is a later event whatever order the requests arrive in.
const lifecycle =
  mode === "join" || mode === "leave" || mode === "leave-member";
const isPrivate = channel.startsWith("G");
// `archive`, `unarchive`, `rename` and `channel-delete` are Slack telling the bot that
// `channel` was archived, unarchived, renamed (to `text`, else "renamed") or
// deleted: `group_*` for a private channel (G), `channel_*` for a public one.
// `seq` seconds are added to event_ts as for `join`.
const channelEvent =
  mode === "archive" ||
  mode === "unarchive" ||
  mode === "rename" ||
  mode === "channel-delete";
const channelEventType = `${isPrivate ? "group" : "channel"}_${
  mode === "channel-delete" ? "deleted" : mode
}`;
// `edit`, `delete`, `delete-bot` and `tombstone` change U0MOCK's post `seq`
// in `channel` (a D… channel is a DM) the way Slack reports it: an edit, a
// delete (of a reply in thread `parent` unless it is 0; of another app's bot
// post for delete-bot), and the tombstone a parent with replies becomes. The
// last word tags the event id, so the same change can come as a new event.
const change =
  mode === "edit" ||
  mode === "delete" ||
  mode === "delete-bot" ||
  mode === "tombstone";
const target = `${1792800000 + Number(seq)}.000001`;
const changedAt = `${Math.floor(Date.now() / 1000)}.000002`;
const changeChannelType = channel.startsWith("D")
  ? "im"
  : isPrivate
    ? "group"
    : "channel";
const thread =
  parent && parent !== "0"
    ? { thread_ts: `${1792800000 + Number(parent)}.000001` }
    : {};
const original = {
  type: "message",
  user: "U0MOCK",
  text: "verify plain post",
  ts: target,
  ...thread,
};
const changeEvent = {
  type: "message",
  hidden: true,
  channel,
  channel_type: changeChannelType,
  ts: changedAt,
  event_ts: changedAt,
  ...(mode === "edit"
    ? {
        subtype: "message_changed",
        message: {
          ...original,
          text: "verify edited post",
          edited: { user: "U0MOCK", ts: changedAt },
        },
        previous_message: original,
      }
    : mode === "tombstone"
      ? {
          subtype: "message_changed",
          message: {
            type: "message",
            subtype: "tombstone",
            user: "USLACKBOT",
            hidden: true,
            text: "This message was deleted.",
            ts: target,
            thread_ts: target,
            reply_count: 1,
          },
          previous_message: { ...original, thread_ts: target },
        }
      : {
          subtype: "message_deleted",
          deleted_ts: target,
          previous_message:
            mode === "delete-bot"
              ? {
                  type: "message",
                  subtype: "bot_message",
                  bot_id: "B0VERIFY",
                  text: "verify bot post",
                  ts: target,
                }
              : original,
        }),
};
// A sequence number stands for the ts 1792800000+n.000001; a full ts (a post
// the outbox made, read from slack_outbox) is taken as it is, and a `parent`
// of 0 is no thread.
function slackTsOf(n: string): string | undefined {
  if (n === "0") return undefined;
  return n.includes(".") ? n : `${1792800000 + Number(n)}.000001`;
}
const ts = posted
  ? (slackTsOf(seq) ?? "1792800000.000001")
  : "1792800000.000001";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const db = drizzle(pool, { schema });
  const secretKey = loadSecretKey(process.env);
  const app = await createSlackSigningSecrets({
    apps: createPostgresSlackAppStore(db, secretKey),
    secrets: createPostgresSecretStore(db, secretKey),
  }).forAgent(agentId);
  if (!app) throw new Error("create agent Slack app first");
  const payload =
    mode === "challenge"
      ? { type: "url_verification", challenge: "verify-challenge" }
      : {
          type: "event_callback",
          api_app_id: app.appId,
          team_id: "T0MOCK",
          // `uninstall` is app_uninstalled sent now (seq makes a new event
          // id; the same seq is a retry); `uninstall-late` is one Slack sent
          // an hour ago, so a reinstall since has superseded it.
          ...(change ? { event_time: Math.floor(Date.now() / 1000) } : {}),
          ...(uninstalled
            ? {
                event_time:
                  Math.floor(Date.now() / 1000) -
                  (mode === "uninstall-late" ? 3600 : 0),
              }
            : {}),
          event_id: channelEvent
            ? `EvVerify${mode.replace("-", "")}${channel}${seq}`
            : mode === "bot"
              ? "EvVerifyBot"
              : uninstalled
                ? `EvVerifyUninstall${mode.replace("-", "")}${seq}`
                : change
                  ? `EvVerify${mode.replace("-", "")}${channel}${seq}${text ?? ""}`
                  : posted || lifecycle
                    ? `EvVerify${mode.replace("-", "")}${channel}${seq.replace(/\W/g, "")}`
                    : "EvVerify1",
          event: channelEvent
            ? {
                type: channelEventType,
                channel:
                  mode === "rename"
                    ? { id: channel, name: text || "renamed", created: 1 }
                    : channel,
                ...(mode === "archive" || mode === "unarchive"
                  ? { user: "U0MOCK" }
                  : {}),
                event_ts: `${Math.floor(Date.now() / 1000) + Number(seq)}.000001`,
              }
            : change
              ? changeEvent
              : uninstalled
                ? { type: "app_uninstalled" }
                : lifecycle
                  ? {
                      ...(mode === "leave"
                        ? { type: isPrivate ? "group_left" : "channel_left" }
                        : {
                            type:
                              mode === "join"
                                ? "member_joined_channel"
                                : "member_left_channel",
                            user: `U${app.appId}BOT`,
                            channel_type: isPrivate ? "G" : "C",
                          }),
                      channel,
                      event_ts: `${Math.floor(Date.now() / 1000) + Number(seq)}.000001`,
                    }
                  : echo
                    ? mode === "slackbot"
                      ? {
                          type: "message",
                          channel_type: channel.startsWith("D")
                            ? "im"
                            : "channel",
                          user: "USLACK",
                          channel,
                          ts,
                          text: text || "You were removed from #verify.",
                        }
                      : {
                          type: "message",
                          channel_type: "channel",
                          channel,
                          ts,
                          thread_ts: slackTsOf(parent ?? ""),
                          bot_id: "B0VERIFYOWN",
                          app_id: app.appId,
                          text: text || "verify echo",
                          ...(mode === "own-mirror"
                            ? {
                                subtype: "bot_message",
                                username: "Verify (웹 콘솔)",
                              }
                            : { user: `U${app.appId}BOT` }),
                        }
                    : mode === "plain" || mode === "reply"
                      ? {
                          type: "message",
                          // A D… channel is U0MOCK's DM with the bot.
                          channel_type: channel.startsWith("D")
                            ? "im"
                            : "channel",
                          user: "U0MOCK",
                          channel,
                          ts,
                          text: text || "verify plain post",
                          ...(mode === "reply"
                            ? {
                                thread_ts: slackTsOf(parent ?? ""),
                              }
                            : {}),
                        }
                      : {
                          type: "app_mention",
                          user: botMention ? "U0REVIEWBOT" : "U0MOCK",
                          channel: posted ? channel : "C0VERIFY",
                          ts,
                          text: text || "verify inbox",
                          ...(mode === "bot" ? { bot_id: "B0VERIFY" } : {}),
                          ...(botMention ? { bot_id: "B0REVIEW" } : {}),
                          ...((botMention || mode === "mention") &&
                          parent &&
                          parent !== "0"
                            ? {
                                thread_ts: slackTsOf(parent ?? ""),
                              }
                            : {}),
                        },
        };
  const body = mode === "malformed" ? "{" : JSON.stringify(payload);
  const timestamp = String(
    Math.floor(Date.now() / 1000) - (mode === "stale" ? 301 : 0),
  );
  const signature = `v0=${createHmac("sha256", app.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const response = await fetch(
    `http://127.0.0.1:3000/v1/slack/events/${agentId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature":
          mode === "bad" ? `v0=${"0".repeat(64)}` : signature,
      },
      body,
    },
  );
  console.log(await response.text());
  console.log(response.status);
} finally {
  await pool.end();
}
