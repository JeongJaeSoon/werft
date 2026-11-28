import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

// 94S-2543: the card a press of a permission, question, push or turn button
// is checked against, and the link whose channel judges it.

let client: PGlite;
let db: Database;
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();
const TS = "1761300000.000200";

beforeAll(async () => {
  client = await migratedPGlite();
  // The rows a card names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function link(
  sessionId: string,
  over: {
    channelId?: string;
    role?: "primary" | "mirror";
    revoked?: boolean;
  } = {},
) {
  const id = crypto.randomUUID();
  await client.query(
    // Closed: one open link per session, and a card's link may be closed.
    `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id, surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id, release_id, role, closed_at, closed_reason, revoked_at)
     VALUES ($1, $2, 'owner', $3, $4, $5, $6, $7, '1.0', '1.0', $8, 'r1', $9, now(), 'completed', $10)`,
    [
      id,
      WORKSPACE,
      sessionId,
      INSTALL,
      crypto.randomUUID(),
      `ref-${id}`,
      over.channelId ?? "C0ROOM",
      AGENT,
      over.role ?? "primary",
      over.revoked ? new Date().toISOString() : null,
    ],
  );
  return id;
}

async function card(input: {
  sessionId: string;
  linkId: string | null;
  agentId?: string;
  channelId: string;
  kind?: "input_notice" | "failure_notice" | "notice";
  dedupeKey: string;
  // null: a post that never came back with its ts.
  slackTs?: string | null;
  status?: "pending" | "sending" | "uncertain" | "failed";
  errorCode?: string;
}) {
  await client.query(
    // A notice goes to one person alone.
    `INSERT INTO slack_outbox (id, workspace_id, agent_id, slack_app_id, installation_id, kind, channel_id, thread_ts, session_id, session_link_id, body, dedupe_key, status, slack_ts, slack_user_id, claim_token, lease_expires_at, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '1.0', $8, $9, '{"text":"card"}', $10, $13, $11, $12, $14, $15, $16)`,
    [
      crypto.randomUUID(),
      WORKSPACE,
      input.agentId ?? AGENT,
      crypto.randomUUID(),
      INSTALL,
      input.kind ?? "input_notice",
      input.channelId,
      input.sessionId,
      input.linkId,
      input.dedupeKey,
      input.slackTs === undefined ? TS : input.slackTs,
      input.kind === "notice" ? "U0ONE" : null,
      input.status ?? (input.slackTs === null ? "uncertain" : "sent"),
      // A send under way holds its claim.
      input.status === "sending" ? crypto.randomUUID() : null,
      input.status === "sending"
        ? new Date(Date.now() + 60_000).toISOString()
        : null,
      input.errorCode ?? null,
    ],
  );
}

const store = () => createPostgresSlackOutboxStore(db);

describe("the card a pressed message is", () => {
  test("is the row's own link, a mirror's when the card went out on one", async () => {
    const sessionId = crypto.randomUUID();
    const primary = await link(sessionId);
    const mirror = await link(sessionId, {
      role: "mirror",
      channelId: "C0MIRROR",
    });
    await card({
      sessionId,
      linkId: primary,
      channelId: "C0ROOM",
      dedupeKey: `prompt:${primary}:toolu_1`,
    });
    await card({
      sessionId,
      linkId: mirror,
      channelId: "C0MIRROR",
      dedupeKey: `prompt:${mirror}:toolu_1`,
    });
    const at = (channelId: string) =>
      store().postedCard({
        sessionId,
        agentId: AGENT,
        channelId,
        slackTs: TS,
        card: { kind: "prompt", requestId: "toolu_1" },
      });
    expect(await at("C0ROOM")).toEqual({
      id: primary,
      agentId: AGENT,
      channelId: "C0ROOM",
      threadId: "1.0",
    });
    expect(await at("C0MIRROR")).toEqual({
      id: mirror,
      agentId: AGENT,
      channelId: "C0MIRROR",
      threadId: "1.0",
    });
  });

  test("names its session, its request or turn, its kind, its channel and its ts", async () => {
    const sessionId = crypto.randomUUID();
    const other = crypto.randomUUID();
    const l = await link(sessionId);
    const push = crypto.randomUUID();
    await card({
      sessionId,
      linkId: l,
      channelId: "C0ROOM",
      dedupeKey: `prompt:${l}:toolu_1`,
    });
    await card({
      sessionId,
      linkId: l,
      channelId: "C0ROOM",
      dedupeKey: `push:${l}:${push}`,
      slackTs: "1761300000.000300",
    });
    await card({
      sessionId,
      linkId: l,
      channelId: "C0ROOM",
      kind: "failure_notice",
      dedupeKey: `failure:${l}:3`,
      slackTs: "1761300000.000400",
    });
    const found = async (
      input: Parameters<ReturnType<typeof store>["postedCard"]>[0],
    ) => {
      const got = await store().postedCard(input);
      return typeof got === "object" && got !== null ? got.id : got;
    };
    const prompt = {
      sessionId,
      agentId: AGENT,
      channelId: "C0ROOM",
      slackTs: TS,
      card: { kind: "prompt", requestId: "toolu_1" },
    } as const;
    expect(await found(prompt)).toBe(l);
    expect(await found({ ...prompt, sessionId: other })).toBeNull();
    expect(await found({ ...prompt, sessionId: "not-a-uuid" })).toBeNull();
    expect(await found({ ...prompt, channelId: "C0ELSE" })).toBeNull();
    expect(await found({ ...prompt, slackTs: "1761300000.000999" })).toBeNull();
    expect(
      await found({
        ...prompt,
        card: { kind: "prompt", requestId: "toolu_2" },
      }),
    ).toBeNull();
    // A permission card is no push card of the same id, nor the reverse.
    expect(
      await found({
        ...prompt,
        card: { kind: "push", pushRequestId: "toolu_1" },
      }),
    ).toBeNull();
    const pushed = {
      ...prompt,
      slackTs: "1761300000.000300",
      card: { kind: "push", pushRequestId: push },
    } as const;
    expect(await found(pushed)).toBe(l);
    expect(
      await found({ ...pushed, card: { kind: "prompt", requestId: push } }),
    ).toBeNull();
    const turn = {
      ...prompt,
      slackTs: "1761300000.000400",
      card: { kind: "turn", turnId: 3 },
    } as const;
    expect(await found(turn)).toBe(l);
    expect(
      await found({ ...turn, card: { kind: "turn", turnId: 4 } }),
    ).toBeNull();
    // A notice to one person under a turn's key holds no button.
    await card({
      sessionId,
      linkId: l,
      channelId: "C0ROOM",
      kind: "notice",
      dedupeKey: `failure:${l}:5`,
      slackTs: "1761300000.000500",
    });
    expect(
      await found({
        ...turn,
        slackTs: "1761300000.000500",
        card: { kind: "turn", turnId: 5 },
      }),
    ).toBeNull();
  });

  test("is no card whose key names another link, whose link is another session's, or whose link is revoked", async () => {
    const sessionId = crypto.randomUUID();
    const own = await link(sessionId);
    const elsewhere = await link(crypto.randomUUID(), { channelId: "C0ROOM" });
    const revoked = await link(sessionId, { revoked: true });
    await card({
      sessionId,
      linkId: own,
      channelId: "C0ROOM",
      dedupeKey: `prompt:${elsewhere}:q_1`,
    });
    await card({
      sessionId,
      linkId: elsewhere,
      channelId: "C0ROOM",
      dedupeKey: `prompt:${elsewhere}:q_2`,
      slackTs: "1761300000.000300",
    });
    await card({
      sessionId,
      linkId: revoked,
      channelId: "C0ROOM",
      dedupeKey: `prompt:${revoked}:q_3`,
      slackTs: "1761300000.000400",
    });
    const at = (slackTs: string, requestId: string) =>
      store().postedCard({
        sessionId,
        agentId: AGENT,
        channelId: "C0ROOM",
        slackTs,
        card: { kind: "prompt", requestId },
      });
    expect(await at(TS, "q_1")).toBeNull();
    expect(await at("1761300000.000300", "q_2")).toBeNull();
    expect(await at("1761300000.000400", "q_3")).toBeNull();
  });

  test("is earlier for a card of its key in that channel posted without its link, or whose ts never came back", async () => {
    const sessionId = crypto.randomUUID();
    const l = await link(sessionId);
    const push = crypto.randomUUID();
    // What a version before the link column wrote: the key, no link.
    await card({
      sessionId,
      linkId: null,
      channelId: "C0ROOM",
      dedupeKey: `prompt:${l}:toolu_1`,
    });
    await card({
      sessionId,
      linkId: l,
      channelId: "C0ROOM",
      dedupeKey: `push:${l}:${push}`,
      slackTs: null,
    });
    await card({
      sessionId,
      linkId: l,
      channelId: "C0ROOM",
      kind: "failure_notice",
      dedupeKey: `failure:${l}:3`,
      slackTs: null,
    });
    const at = (
      card: Parameters<ReturnType<typeof store>["postedCard"]>[0]["card"],
      over: {
        channelId?: string;
        slackTs?: string;
        sessionId?: string;
        agentId?: string;
      } = {},
    ) =>
      store().postedCard({
        sessionId,
        agentId: AGENT,
        channelId: "C0ROOM",
        slackTs: TS,
        card,
        ...over,
      });
    const prompt = { kind: "prompt", requestId: "toolu_1" } as const;
    expect(await at(prompt)).toBe("earlier");
    // Without its link the ts still names the message.
    expect(await at(prompt, { slackTs: "1761300000.000999" })).toBeNull();
    expect(await at(prompt, { channelId: "C0ELSE" })).toBeNull();
    expect(await at(prompt, { sessionId: crypto.randomUUID() })).toBeNull();
    expect(await at({ kind: "prompt", requestId: "toolu_11" })).toBeNull();
    expect(await at({ kind: "prompt", requestId: "oolu_1" })).toBeNull();
    // A key whose middle is no link id is no card's.
    await card({
      sessionId,
      linkId: null,
      channelId: "C0ROOM",
      dedupeKey: "prompt:x:toolu_9",
    });
    expect(await at({ kind: "prompt", requestId: "toolu_9" })).toBeNull();
    expect(await at({ kind: "push", pushRequestId: "toolu_1" })).toBeNull();
    // No ts came back: any message of that channel may be it.
    expect(await at({ kind: "push", pushRequestId: push })).toBe("earlier");
    expect(await at({ kind: "prompt", requestId: push })).toBeNull();
    expect(await at({ kind: "turn", turnId: 3 })).toBe("earlier");
    expect(await at({ kind: "turn", turnId: 33 })).toBeNull();
    expect(
      await at({ kind: "turn", turnId: 3 }, { channelId: "C0ELSE" }),
    ).toBeNull();
    // Only the pressing agent's rows, and none under a revoked link.
    expect(await at(prompt, { agentId: crypto.randomUUID() })).toBeNull();
    expect(
      await at(
        { kind: "push", pushRequestId: push },
        { agentId: "not-a-uuid" },
      ),
    ).toBeNull();
    const revoked = await link(sessionId, { revoked: true });
    await card({
      sessionId,
      linkId: revoked,
      channelId: "C0ROOM",
      dedupeKey: `prompt:${revoked}:toolu_7`,
      slackTs: null,
    });
    expect(await at({ kind: "prompt", requestId: "toolu_7" })).toBeNull();
    // Another agent's row in the same channel tells this one nothing.
    await card({
      sessionId,
      linkId: l,
      agentId: crypto.randomUUID(),
      channelId: "C0ROOM",
      dedupeKey: `prompt:${l}:toolu_8`,
      slackTs: null,
    });
    expect(await at({ kind: "prompt", requestId: "toolu_8" })).toBeNull();
    // A post in flight may be up already; one never tried or given up on is not.
    for (const [requestId, status] of [
      ["toolu_20", "sending"],
      ["toolu_21", "pending"],
      ["toolu_22", "failed"],
    ] as const) {
      await card({
        sessionId,
        linkId: l,
        channelId: "C0ROOM",
        dedupeKey: `prompt:${l}:${requestId}`,
        slackTs: null,
        status,
      });
    }
    expect(await at({ kind: "prompt", requestId: "toolu_20" })).toBe("earlier");
    expect(await at({ kind: "prompt", requestId: "toolu_21" })).toBeNull();
    expect(await at({ kind: "prompt", requestId: "toolu_22" })).toBeNull();
    // Slack took it but answered with no ts: it is up, so it is earlier.
    await card({
      sessionId,
      linkId: l,
      channelId: "C0ROOM",
      dedupeKey: `prompt:${l}:toolu_23`,
      slackTs: null,
      status: "failed",
      errorCode: "missing_ts",
    });
    expect(await at({ kind: "prompt", requestId: "toolu_23" })).toBe("earlier");
  });
});
