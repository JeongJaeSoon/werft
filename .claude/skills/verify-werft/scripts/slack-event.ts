// Runs inside this verification project's API container; never returns credentials.
import { createHmac } from "node:crypto";
import * as schema from "@werft-ai/db";
import {
  createPostgresSecretStore,
  createPostgresSlackAppStore,
} from "@werft-ai/db";
import { createSlackSigningSecrets } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadSecretKey } from "./apps/control-host/src/api/catalog-config.ts";

const [agentId, mode, channel = "C0VERIFY", seq = "1", parent, text] =
  process.argv.slice(1);
// `mention` and `plain` are top-level posts by U0MOCK in `channel`, with
// or without a mention; each sequence number is its own event and thread.
// `reply` is an unmentioned post in the thread `parent` opened.
const posted = mode === "mention" || mode === "plain" || mode === "reply";
const uninstalled = mode === "uninstall" || mode === "uninstall-late";
// `join` and `leave` are this app's bot entering or leaving `channel`
// (private by the mock's G prefix). `seq` seconds are added to the current
// time for event_ts, so a higher seq is a later event whatever order the
// requests arrive in.
const lifecycle = mode === "join" || mode === "leave";
const ts = posted ? `${1792800000 + Number(seq)}.000001` : "1792800000.000001";
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
          ...(uninstalled
            ? {
                event_time:
                  Math.floor(Date.now() / 1000) -
                  (mode === "uninstall-late" ? 3600 : 0),
              }
            : {}),
          event_id:
            mode === "bot"
              ? "EvVerifyBot"
              : uninstalled
                ? `EvVerifyUninstall${mode.replace("-", "")}${seq}`
                : posted || lifecycle
                  ? `EvVerify${mode}${channel}${seq}`
                  : "EvVerify1",
          event: uninstalled
            ? { type: "app_uninstalled" }
            : lifecycle
              ? {
                  type:
                    mode === "join"
                      ? "member_joined_channel"
                      : "member_left_channel",
                  user: `U${app.appId}BOT`,
                  channel,
                  channel_type: "G",
                  event_ts: `${Math.floor(Date.now() / 1000) + Number(seq)}.000001`,
                }
              : mode === "plain" || mode === "reply"
              ? {
                  type: "message",
                  channel_type: "channel",
                  user: "U0MOCK",
                  channel,
                  ts,
                  text: text || "verify plain post",
                  ...(mode === "reply"
                    ? { thread_ts: `${1792800000 + Number(parent)}.000001` }
                    : {}),
                }
              : {
                  type: "app_mention",
                  user: "U0MOCK",
                  channel: posted ? channel : "C0VERIFY",
                  ts,
                  text: text || "verify inbox",
                  ...(mode === "bot" ? { bot_id: "B0VERIFY" } : {}),
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
