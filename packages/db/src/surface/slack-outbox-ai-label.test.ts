import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SurfaceOutboxEntry } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

// v1-b/G2: the send, a card's redraw and a notice's redraw read the AI line:
// only under the agent's rollout `on`, named for whoever sent the turn the
// row is about.

const ENGINE = testDatabaseUrl() ? "PostgreSQL" : "PGlite";

let client: {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
  exec: (text: string) => Promise<unknown>;
};
let db: Database;
let close = async () => {};
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();
const SESSION = crypto.randomUUID();
const LINK = crypto.randomUUID();
const ADA = crypto.randomUUID();
const GRACE = crypto.randomUUID();
const PUSH = crypto.randomUUID();
const INTENT = crypto.randomUUID();
// A push Grace's turn asked for in the session Ada created.
const INTENT_PUSH = crypto.randomUUID();

beforeAll(async () => {
  if (ENGINE === "PGlite") {
    const pglite = await migratedPGlite();
    client = pglite;
    db = drizzle(pglite, { schema }) as unknown as Database;
    close = () => pglite.close();
  } else {
    const database = await createTempDatabase({ prefix: "ai_label" });
    // One connection, so the session setting below holds for every query.
    const pool = new Pool({ connectionString: database.url, max: 1 });
    client = {
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
    };
    db = drizzlePostgres(pool, { schema }) as unknown as Database;
    close = async () => {
      await pool.end();
      await database.drop();
    };
  }
  // The rows a row names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0APP', 'T0INSTALL')",
    [INSTALL, WORKSPACE],
  );
  await client.query(
    "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'payments', 'Payments Agent', $3)",
    [AGENT, WORKSPACE, crypto.randomUUID()],
  );
  for (const [id, name] of [
    [ADA, "Ada"],
    [GRACE, "Grace"],
  ]) {
    await client.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)",
      [id, `${name?.toLowerCase()}@example.com`, name],
    );
  }
  await client.query(
    "INSERT INTO sessions (id, workspace_id, owner_id, repository_mode) VALUES ($1, $2, 'owner', 'none')",
    [SESSION, WORKSPACE],
  );
  await client.query(
    `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id, surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id, release_id)
     VALUES ($1, $2, 'owner', $3, $4, $5, '1.1', 'C0ROOM', '1.1', '1.1', $6, 'release-1')`,
    [LINK, WORKSPACE, SESSION, INSTALL, crypto.randomUUID(), AGENT],
  );
  // Turn 1 is Ada's, turn 2 Grace's, turn 3 no user's.
  for (const [sequence, actor] of [
    [1, ADA],
    [2, GRACE],
    [3, null],
  ]) {
    await client.query(
      "INSERT INTO turns (session_id, sequence, message, status, actor_id) VALUES ($1, $2, 'go', 'completed', $3)",
      [SESSION, sequence, actor],
    );
  }
  await client.query(
    `INSERT INTO push_requests (id, owner_id, session_id, repository_id, checkpoint_revision, git_commit, target_branch, requested_by, request_receipt_id)
     VALUES ($1, 'owner', $2, 'app', 1, repeat('a', 40), $5, $3, $4)`,
    [
      PUSH,
      SESSION,
      JSON.stringify({ actor_user_id: GRACE }),
      crypto.randomUUID(),
      `agent/${SESSION}`,
    ],
  );
  await client.query(
    `INSERT INTO push_intents (id, owner_id, session_id, turn_id, attempt_id, repository_id, target_branch, actor, status, refusal_code)
     SELECT $1, 'owner', $2, id, 'attempt', 'app', $3, '{}'::jsonb, 'cancelled', 'session_closed'
     FROM turns WHERE session_id = $2 AND sequence = 2`,
    [INTENT, SESSION, `agent/${SESSION}`],
  );
  await client.query(
    `INSERT INTO push_requests (id, owner_id, session_id, repository_id, checkpoint_revision, git_commit, target_branch, requested_by, request_receipt_id, origin, flow)
     VALUES ($1, 'owner', $2, 'app', 1, repeat('b', 40), $5, $3, $4, 'intent', 'actions')`,
    [
      INTENT_PUSH,
      SESSION,
      JSON.stringify({ actor_user_id: ADA }),
      crypto.randomUUID(),
      `agent/${SESSION}-b`,
    ],
  );
  await client.query(
    `INSERT INTO push_intents (id, owner_id, session_id, turn_id, attempt_id, repository_id, target_branch, actor, status, pinned_revision, push_request_id)
     SELECT $1, 'owner', $2, id, 'attempt', 'app', $3, '{}'::jsonb, 'requested', 1, $4
     FROM turns WHERE session_id = $2 AND sequence = 2`,
    [crypto.randomUUID(), SESSION, `agent/${SESSION}-b`, INTENT_PUSH],
  );
}, 60_000);

afterAll(() => close(), 60_000);

const rollout = (value: "off" | "shadow" | "on") =>
  client.query("UPDATE agents SET conversation_rollout = $1 WHERE id = $2", [
    value,
    AGENT,
  ]);

async function begun(dedupeKey: string, sourcesTurn: number | null) {
  await client.exec("DELETE FROM slack_outbox");
  const outbox = createPostgresSlackOutboxStore(db);
  const entry: SurfaceOutboxEntry = {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    slackAppId: crypto.randomUUID(),
    installationId: INSTALL,
    kind: "failure_notice",
    channelId: "C0ROOM",
    threadTs: "1.1",
    slackUserId: null,
    sessionId: SESSION,
    sessionLinkId: LINK,
    body: { text: "Done." },
    dedupeKey,
    sourcesTurn,
  };
  expect(await outbox.enqueue(entry)).toBe("enqueued");
  const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
  if (claim === undefined) throw new Error("no claim");
  const sent = await outbox.beginSend(claim);
  if (typeof sent !== "object") throw new Error(`not begun: ${sent}`);
  return sent.aiLabel;
}

describe(`the AI line a row reads on ${ENGINE}`, () => {
  test("is read only while the rollout is on", async () => {
    for (const value of ["off", "shadow"] as const) {
      await rollout(value);
      expect(await begun(`reply:${LINK}:1`, 1)).toBeUndefined();
    }
    await rollout("on");
    expect(await begun(`reply:${LINK}:1`, 1)).toEqual({ requestedBy: "Ada" });
  });

  test("names the sender of the turn the row is about", async () => {
    await rollout("on");
    const named: [string, number | null, string | null][] = [
      [`failure:${LINK}:2`, 2, "Grace"],
      [`prompt:${LINK}:request-1`, 1, "Ada"],
      // What the engine said after turn 2 ended is that turn's.
      [`after_turn:${LINK}:2:9`, 2, "Grace"],
      // A push is its requester's, whatever turn its sources name.
      [`push:${LINK}:${PUSH}`, 1, "Grace"],
      [`action:${PUSH}:pushed`, null, "Grace"],
      [`intent:${INTENT}:ended`, null, "Grace"],
      // An intent's push is its turn's sender's, not the session creator's.
      [`push:${LINK}:${INTENT_PUSH}`, 1, "Grace"],
      [`action:${INTENT_PUSH}:pushed`, null, "Grace"],
      // A turn no user sent.
      [`reply:${LINK}:3`, 3, null],
      // Rows that are no one turn's result, even with its sources.
      [`uncertain:${crypto.randomUUID()}`, 1, null],
      [`capacity_wait:${LINK}:execution:1`, null, null],
      [`thread_notice:${crypto.randomUUID()}`, null, null],
      [`notice:${crypto.randomUUID()}`, null, null],
    ];
    for (const [key, turn, requestedBy] of named) {
      expect([key, await begun(key, turn)]).toEqual([key, { requestedBy }]);
    }
  });

  test("is read for a posted card's redraw", async () => {
    for (const [value, expected] of [
      ["shadow", undefined],
      ["on", { requestedBy: "Ada" }],
    ] as const) {
      await rollout(value);
      await begun(`prompt:${LINK}:request-2`, 1);
      await client.exec(
        "UPDATE slack_outbox SET kind = 'input_notice', status = 'sent', slack_ts = '2.2', settle_state = 'due', claim_token = NULL, lease_expires_at = NULL",
      );
      const cards = createPostgresSlackOutboxStore(db).cards;
      const [card] =
        (await cards?.claim({ limit: 1, leaseMs: 30_000, graceMs: 0 })) ?? [];
      expect(card?.dedupeKey).toBe(`prompt:${LINK}:request-2`);
      expect(card?.aiLabel).toEqual(expected);
    }
  });

  test("is read for a turn's notice redrawn after its post", async () => {
    const outbox = createPostgresSlackOutboxStore(db);
    const turn = { agentId: AGENT, sessionId: SESSION, turnId: 2 };
    await rollout("off");
    expect(await outbox.aiLabelFor(turn)).toBeNull();
    await rollout("on");
    expect(await outbox.aiLabelFor(turn)).toEqual({ requestedBy: "Grace" });
  });
});
