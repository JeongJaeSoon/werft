import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SurfaceOutboxEntry } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

// v1-b/G1 (A3): a claimed row carries the scope of the conversation its
// session belongs to, read by the server, not by the text.

let client: PGlite;
let db: Database;
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();

beforeAll(async () => {
  client = await migratedPGlite();
  // The rows a row names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0APP', 'T0INSTALL')",
    [INSTALL, WORKSPACE],
  );
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function sessionIn(
  conversation: {
    kind: "channel" | "dm";
    teamId: string | null;
    channelId: string | null;
  } | null,
) {
  const sessionId = crypto.randomUUID();
  let parent: string | null = null;
  if (conversation !== null) {
    parent = crypto.randomUUID();
    await client.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id, person_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        parent,
        WORKSPACE,
        AGENT,
        conversation.kind,
        conversation.teamId,
        conversation.channelId,
        conversation.kind === "dm" ? crypto.randomUUID() : null,
      ],
    );
  }
  await client.query(
    "INSERT INTO sessions (id, owner_id, repository_mode, parent_conversation_id) VALUES ($1, 'owner', 'none', $2)",
    [sessionId, parent],
  );
  return sessionId;
}

// A model notice needs no link, so the claim reads only what is under test.
function entryOf(sessionId: string | null): SurfaceOutboxEntry {
  return {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    slackAppId: crypto.randomUUID(),
    installationId: INSTALL,
    kind: "model_notice",
    channelId: "U0PERSON",
    threadTs: "",
    slackUserId: null,
    sessionId,
    sessionLinkId: null,
    body: { text: "Done." },
    dedupeKey: crypto.randomUUID(),
  };
}

async function claimedScope(sessionId: string | null) {
  await client.exec("DELETE FROM slack_outbox");
  const outbox = createPostgresSlackOutboxStore(db);
  expect(await outbox.enqueue(entryOf(sessionId))).toBe("enqueued");
  const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
  return claim?.conversationScope;
}

describe("claiming an outbox row", () => {
  test("reads its session's channel conversation", async () => {
    const session = await sessionIn({
      kind: "channel",
      teamId: "T0ACME",
      channelId: "C0ROOM",
    });
    expect(await claimedScope(session)).toEqual({
      kind: "channel",
      teamId: "T0ACME",
      channelId: "C0ROOM",
    });
  });

  test("gives a DM conversation its install's team", async () => {
    const session = await sessionIn({
      kind: "dm",
      teamId: null,
      channelId: null,
    });
    expect(await claimedScope(session)).toEqual({
      kind: "dm",
      teamId: "T0INSTALL",
      channelId: null,
    });
  });

  test("has none without a session or its parent conversation", async () => {
    expect(await claimedScope(null)).toBeNull();
    expect(await claimedScope(await sessionIn(null))).toBeNull();
  });
});

// v1-b/G1b (94S-2213): a card is drawn, and redrawn, in the same scope.
describe("a card's conversation scope", () => {
  const room = (channelId: string) =>
    ({ kind: "channel", teamId: "T0ACME", channelId }) as const;

  test("comes with a sent card the settle pass claims", async () => {
    await client.exec("DELETE FROM slack_outbox");
    const ROOM = room("C0CARD");
    const session = await sessionIn(ROOM);
    const outbox = createPostgresSlackOutboxStore(db);
    expect(
      await outbox.enqueue({
        ...entryOf(session),
        kind: "input_notice",
        channelId: "C0ROOM",
        threadTs: "1.0",
        body: { text: "card", blocks: [] },
      }),
    ).toBe("enqueued");
    await client.exec(
      "UPDATE slack_outbox SET status = 'sent', slack_ts = '1.1', settle_state = 'due'",
    );
    const cards = outbox.cards;
    if (cards === undefined) throw new Error("no card store");
    const [claim] = await cards.claim({
      limit: 10,
      leaseMs: 30_000,
      graceMs: 0,
    });
    expect(claim?.conversationScope).toEqual(ROOM);
  });

  test("comes with a request still to be posted", async () => {
    await client.exec("DELETE FROM slack_outbox");
    const ROOM = room("C0ASK");
    const session = await sessionIn(ROOM);
    const appRow = crypto.randomUUID();
    await client.query(
      "INSERT INTO slack_apps (id, workspace_id, kind, agent_id, state, app_id, redirect_url) VALUES ($1, $2, 'agent', $3, 'creating', 'A0APP', 'https://example.test') ON CONFLICT DO NOTHING",
      [appRow, WORKSPACE, AGENT],
    );
    await client.query(
      "INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id, surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id, release_id) VALUES ($1, $2, 'owner', $3, $4, $5, 'ref', 'C0ROOM', '1.0', '1.0', $6, 'r1')",
      [
        crypto.randomUUID(),
        WORKSPACE,
        session,
        INSTALL,
        crypto.randomUUID(),
        AGENT,
      ],
    );
    await client.query(
      "INSERT INTO push_requests (id, owner_id, session_id, repository_id, checkpoint_revision, git_commit, target_branch, requested_by, request_receipt_id) VALUES ($1, 'owner', $2, 'repo-1', 1, $3, $4, '{}'::jsonb, $5)",
      [
        crypto.randomUUID(),
        session,
        "a".repeat(40),
        `agent/${session}`,
        crypto.randomUUID(),
      ],
    );
    const outbox = createPostgresSlackOutboxStore(db);
    const pending = await outbox.unpromptedRequests(10);
    expect(pending.map((row) => row.conversationScope)).toEqual([ROOM]);
  });
});
