import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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

// 94S-2274: a 429 holds every row of the install its limit covers, from any
// replica, until its Retry-After; the call counts as no attempt.

const ENGINE = testDatabaseUrl() ? "PostgreSQL" : "PGlite";

let client: {
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Row[] }>;
  exec: (text: string) => Promise<unknown>;
};
let db: Database;
let close = async () => {};
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();
const APP = crypto.randomUUID();
const BUSY = "C0BUSY";
const QUIET = "C0QUIET";

beforeAll(async () => {
  if (ENGINE === "PGlite") {
    const pglite = await migratedPGlite();
    client = pglite;
    db = drizzle(pglite, { schema }) as unknown as Database;
    close = () => pglite.close();
  } else {
    const database = await createTempDatabase({ prefix: "rate_blocks" });
    // One connection, so the session setting below holds for every query.
    const pool = new Pool({ connectionString: database.url, max: 1 });
    client = {
      query: <Row extends Record<string, unknown>>(
        text: string,
        params?: unknown[],
      ) => pool.query<Row>(text, params),
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
}, 60_000);

afterAll(() => close(), 60_000);

beforeEach(async () => {
  await client.exec(
    "DELETE FROM slack_outbox; DELETE FROM slack_outbox_rate_blocks",
  );
});

const outbox = () => createPostgresSlackOutboxStore(db);

async function enqueue(
  name: string,
  channelId: string,
  more: Partial<SurfaceOutboxEntry> = {},
) {
  const entry: SurfaceOutboxEntry = {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    slackAppId: APP,
    installationId: INSTALL,
    kind: "reply",
    channelId,
    threadTs: "1700000000.000100",
    slackUserId: null,
    sessionId: null,
    sessionLinkId: null,
    body: { text: name },
    dedupeKey: name,
    ...more,
  };
  expect(await outbox().enqueue(entry)).toBe("enqueued");
}

async function claimed(limit = 10) {
  const claims = await outbox().claim({ limit, leaseMs: 30_000 });
  return claims;
}

const names = (claims: { body: { text: string } }[]) =>
  claims.map((claim) => claim.body.text);

// Sent at once, as a send that began would be.
async function sendOne(name: string, slackTs = "1700000000.000200") {
  const [claim] = (await claimed()).filter((c) => c.body.text === name);
  if (claim === undefined) throw new Error(`${name} not claimed`);
  expect(await outbox().beginSend(claim)).toBeTruthy();
  expect(await outbox().settle(claim, { status: "sent", slackTs })).toBe(true);
}

const limited = (retryInMs: number) =>
  ({ status: "pending", errorCode: "ratelimited", retryInMs }) as const;
// chat.update's own.
const editLimited = (retryInMs: number) =>
  ({ status: "pending", errorCode: "ratelimited_edit", retryInMs }) as const;

// Time passes: every wait and every block is over.
async function waitsOver() {
  await client.exec(
    "UPDATE slack_outbox SET next_attempt_at = now() WHERE next_attempt_at > now(); UPDATE slack_outbox_rate_blocks SET blocked_until = now() - interval '1 second'",
  );
}

async function row(name: string) {
  const [found] = (
    await client.query<{
      status: string;
      attempts: number;
      error_code: string | null;
      claimed: boolean;
      wait_ms: number;
    }>(
      "SELECT status, attempts, error_code, claim_token IS NOT NULL AS claimed, extract(epoch from next_attempt_at - now()) * 1000 AS wait_ms FROM slack_outbox WHERE dedupe_key = $1",
      [name],
    )
  ).rows;
  return found;
}

const blocks = async () =>
  (
    await client.query<{ scope: string; wait_ms: number }>(
      "SELECT scope, extract(epoch from blocked_until - now()) * 1000 AS wait_ms FROM slack_outbox_rate_blocks ORDER BY scope",
    )
  ).rows.map(({ scope, wait_ms }) => ({ scope, waitMs: Number(wait_ms) }));

describe(`Slack rate limits in the outbox on ${ENGINE}`, () => {
  test("a 429 holds its channel's next rows until its Retry-After; another channel's still go", async () => {
    await enqueue("first", BUSY);
    await enqueue("second", BUSY);
    await enqueue("elsewhere", QUIET);
    const [first] = await claimed(1);
    if (first === undefined) throw new Error("no claim");
    expect(await outbox().beginSend(first)).toBeTruthy();
    expect(await outbox().settle(first, limited(30_000))).toBe(true);
    const [block] = await blocks();
    expect(block?.scope).toBe(`channel:${BUSY}`);
    expect(block?.waitMs).toBeGreaterThan(25_000);
    expect(block?.waitMs).toBeLessThanOrEqual(30_000);

    expect(names(await claimed())).toEqual(["elsewhere"]);
    await client.exec(
      "DELETE FROM slack_outbox WHERE dedupe_key = 'elsewhere'",
    );
    // Its own wait over, the channel's is not.
    await client.exec("UPDATE slack_outbox SET next_attempt_at = now()");
    expect(await claimed()).toEqual([]);
    await waitsOver();
    expect(names(await claimed())).toEqual(["first", "second"]);
  });

  test("a later 429 never shortens a block", async () => {
    await enqueue("first", BUSY);
    await enqueue("second", BUSY);
    const claims = await claimed();
    for (const [claim, waitMs] of claims.map(
      (claim, i) => [claim, i === 0 ? 60_000 : 5_000] as const,
    )) {
      // As two replicas would: each began before the other's 429.
      await client.exec("DELETE FROM slack_outbox_rate_blocks");
      expect(await outbox().beginSend(claim)).toBeTruthy();
      if (waitMs === 5_000) {
        await client.query(
          "INSERT INTO slack_outbox_rate_blocks VALUES ($1, $2, now() + interval '60 seconds')",
          [INSTALL, `channel:${BUSY}`],
        );
      }
      expect(await outbox().settle(claim, limited(waitMs))).toBe(true);
    }
    expect((await blocks())[0]?.waitMs).toBeGreaterThan(55_000);
  });

  test("a rate-limited call is no attempt: a reply 429ed over and over still goes", async () => {
    await enqueue("answer", BUSY);
    for (let i = 0; i < 15; i++) {
      const [claim] = await claimed();
      if (claim === undefined) throw new Error("no claim");
      expect(claim.attempts).toBe(1);
      expect(await outbox().beginSend(claim)).toBeTruthy();
      expect(await outbox().settle(claim, limited(1_000))).toBe(true);
      expect(await row("answer")).toMatchObject({
        status: "pending",
        attempts: 0,
        error_code: "ratelimited",
      });
      await waitsOver();
    }
    await sendOne("answer");
    expect(await row("answer")).toMatchObject({ status: "sent", attempts: 1 });
  });

  test("a row claimed beside the one that hit the limit is released at its send, unsent and uncounted", async () => {
    await enqueue("first", BUSY);
    await enqueue("second", BUSY);
    await enqueue("elsewhere", QUIET);
    const [first, second, elsewhere] = await claimed();
    if (!first || !second || !elsewhere) throw new Error("no claims");
    expect(await outbox().beginSend(first)).toBeTruthy();
    expect(await outbox().settle(first, limited(20_000))).toBe(true);
    expect(await outbox().beginSend(second)).toBe("rate_limited");
    const held = await row("second");
    expect(held).toMatchObject({
      status: "pending",
      attempts: 0,
      claimed: false,
    });
    expect(Number(held?.wait_ms)).toBeGreaterThan(15_000);
    expect(Number(held?.wait_ms)).toBeLessThanOrEqual(20_000);
    // Its lease is gone: a settle from the pass that claimed it is refused.
    expect(
      await outbox().settle(second, { status: "sent", slackTs: "1.2" }),
    ).toBe(false);
    expect(await outbox().beginSend(elsewhere)).toBeTruthy();
  });

  test("an edit's 429 holds the install's progress updates in every channel, not its posts", async () => {
    await enqueue("step 1", BUSY, { kind: "progress", progressKey: "k1" });
    await sendOne("step 1");
    await enqueue("step 2", BUSY, { kind: "progress", progressKey: "k1" });
    await waitsOver();
    const [edit] = await claimed();
    if (edit === undefined) throw new Error("no claim");
    const begun = await outbox().beginSend(edit);
    expect(begun).toMatchObject({ progress: { ts: "1700000000.000200" } });
    expect(await outbox().settle(edit, editLimited(20_000))).toBe(true);
    expect((await blocks()).map(({ scope }) => scope)).toEqual(["chat.update"]);

    await enqueue("other 1", QUIET, { kind: "progress", progressKey: "k2" });
    await enqueue("reply", BUSY);
    await enqueue("thumbs", BUSY, { kind: "reaction" });
    expect(names(await claimed())).toEqual(["reply", "thumbs"]);
  });

  test("a progress update whose edit gave way to a post holds the channel when that post is 429ed", async () => {
    await enqueue("step 1", BUSY, { kind: "progress", progressKey: "k1" });
    await sendOne("step 1");
    await enqueue("step 2", BUSY, { kind: "progress", progressKey: "k1" });
    await waitsOver();
    const [edit] = await claimed();
    if (edit === undefined) throw new Error("no claim");
    expect(await outbox().beginSend(edit)).toMatchObject({
      progress: { ts: "1700000000.000200" },
    });
    expect(await outbox().settle(edit, limited(20_000))).toBe(true);
    expect((await blocks()).map(({ scope }) => scope)).toEqual([
      `channel:${BUSY}`,
    ]);
    await enqueue("other 1", QUIET, { kind: "progress", progressKey: "k2" });
    await enqueue("reply", BUSY);
    expect(names(await claimed())).toEqual(["other 1"]);
  });

  test("a reaction's 429 holds reactions, not the channel's posts", async () => {
    await enqueue("eyes", BUSY, { kind: "reaction" });
    const [reaction] = await claimed();
    if (reaction === undefined) throw new Error("no claim");
    expect(await outbox().beginSend(reaction)).toBeTruthy();
    expect(await outbox().settle(reaction, limited(20_000))).toBe(true);
    expect((await blocks()).map(({ scope }) => scope)).toEqual([
      "reactions.add",
    ]);
    await enqueue("more eyes", QUIET, {
      kind: "reaction",
      threadTs: "1700000000.000300",
    });
    await enqueue("reply", BUSY);
    expect(names(await claimed())).toEqual(["reply"]);
  });

  test("the last progress update goes once the limit ends, the ones it overtook never", async () => {
    await enqueue("step 1", BUSY, { kind: "progress", progressKey: "k1" });
    await sendOne("step 1");
    await enqueue("step 2", BUSY, { kind: "progress", progressKey: "k1" });
    await waitsOver();
    const [edit] = await claimed();
    if (edit === undefined) throw new Error("no claim");
    await outbox().beginSend(edit);
    expect(await outbox().settle(edit, editLimited(20_000))).toBe(true);
    await enqueue("done", BUSY, { kind: "progress", progressKey: "k1" });
    expect(await claimed()).toEqual([]);
    await waitsOver();
    expect(names(await claimed())).toEqual(["done"]);
    expect(await row("step 2")).toMatchObject({
      status: "failed",
      error_code: "superseded",
    });
  });

  test("a progress message's next edit waits 1.3 s for each of the install's messages waiting, ten seconds at least", async () => {
    for (let s = 0; s < 10; s++) {
      await enqueue(`p${s}`, s % 2 === 0 ? BUSY : QUIET, {
        kind: "progress",
        progressKey: `k${s}`,
      });
    }
    const claims = await claimed();
    expect(claims).toHaveLength(10);
    const [first] = claims;
    if (first === undefined) throw new Error("no claim");
    expect(await outbox().beginSend(first)).toBeTruthy();
    expect(
      await outbox().settle(first, { status: "sent", slackTs: "1.1" }),
    ).toBe(true);
    // Nine others wait: 9 x 1.3 s.
    const waitMs = Number((await row(first.body.text))?.wait_ms);
    expect(waitMs).toBeGreaterThan(11_000);
    expect(waitMs).toBeLessThanOrEqual(11_700);
  });

  test("a progress message alone waits the ten-second interval", async () => {
    await enqueue("alone", BUSY, { kind: "progress", progressKey: "k1" });
    await sendOne("alone");
    const waitMs = Number((await row("alone"))?.wait_ms);
    expect(waitMs).toBeGreaterThan(9_000);
    expect(waitMs).toBeLessThanOrEqual(10_000);
  });
});
