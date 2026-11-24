import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { SecretKey } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { writeSecretInTx } from "../secrets/index.ts";
import { closeSlackApp } from "./slack-app-close.ts";
import { createPostgresSlackAppStore } from "./slack-apps.ts";
import { createPostgresSlackInstallStore } from "./slack-install-states.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

let client: PGlite;
let db: Database;
const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

const WORKSPACE = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const TEAM = "T0CLOSE";

type Seeded = {
  slackAppId: string;
  appId: string;
  installationId: string;
  identityId: string;
  otherAppId: string;
};

beforeAll(async () => {
  client = await migratedPGlite();
  // The rows the seeded rows name are not what is under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

afterAll(async () => {
  await client.close();
});

let seeded: Seeded;

beforeEach(async () => {
  await client.exec(`
    DELETE FROM slack_outbox; DELETE FROM conversation_inputs;
    DELETE FROM conversation_topics; DELETE FROM conversations;
    DELETE FROM surface_bindings; DELETE FROM agent_identities;
    DELETE FROM slack_installations; DELETE FROM slack_apps;
    DELETE FROM receipts; DELETE FROM secret_values;`);
  seeded = await seed();
});

async function seed(): Promise<Seeded> {
  const slackAppId = randomUUID();
  const otherAppId = randomUUID();
  const appId = `A0${randomBytes(4).toString("hex").toUpperCase()}`;
  const installationId = randomUUID();
  const otherInstallationId = randomUUID();
  const identityId = randomUUID();
  for (const [id, agent, slackId, install] of [
    [slackAppId, AGENT, appId, installationId],
    [otherAppId, OTHER_AGENT, "A0OTHER", otherInstallationId],
  ] as const) {
    await client.query(
      `INSERT INTO slack_apps (id, workspace_id, kind, agent_id, state, app_id, client_id, redirect_url)
       VALUES ($1, $2, 'agent', $3, 'created', $4, '1.2', 'https://console.example/cb')`,
      [id, WORKSPACE, agent, slackId],
    );
    await client.query(
      `INSERT INTO slack_installations (id, workspace_id, app_id, team_id, bot_user_id, status, verified_at)
       VALUES ($1, $2, $3, $4, 'U0BOT', 'verified', now() - interval '1 hour')`,
      [install, WORKSPACE, slackId, TEAM],
    );
  }
  await client.query(
    `INSERT INTO agent_identities (id, workspace_id, agent_id, provider, installation_id, external_principal_id, credential_ref)
     VALUES ($1, $2, $3, 'slack_bot', $4, 'U0BOT', $5)`,
    [
      identityId,
      WORKSPACE,
      AGENT,
      installationId,
      `slack-app/${slackAppId}/bot`,
    ],
  );
  for (const [channel, install, agent] of [
    ["C0ONE", installationId, AGENT],
    ["C0TWO", installationId, AGENT],
    ["C0KEEP", otherInstallationId, OTHER_AGENT],
  ] as const) {
    await client.query(
      `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface, installation_id, external_surface_id, surface_kind, status, mode, listen, ceiling_actions, ceiling_disclosure)
       VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'ready', 'on', 'free', ARRAY['session.read'], 'summary')`,
      [randomUUID(), WORKSPACE, agent, install, channel],
    );
  }
  for (const [status, app, install] of [
    ["pending", slackAppId, installationId],
    ["pending", slackAppId, installationId],
    ["sending", slackAppId, installationId],
    ["sent", slackAppId, installationId],
    ["pending", otherAppId, otherInstallationId],
  ] as const) {
    const sending = status === "sending";
    await client.query(
      `INSERT INTO slack_outbox (id, workspace_id, agent_id, slack_app_id, installation_id, kind, channel_id, thread_ts, body, dedupe_key, status, claim_token, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'reply', 'C0ONE', '', '{"text":"hi"}', $6, $7, $8, $9)`,
      [
        randomUUID(),
        WORKSPACE,
        AGENT,
        app,
        install,
        randomUUID(),
        status,
        sending ? randomUUID() : null,
        sending ? new Date(Date.now() + 60_000) : null,
      ],
    );
  }
  for (const agent of [AGENT, OTHER_AGENT]) {
    const conversation = randomUUID();
    const topic = randomUUID();
    await client.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id)
       VALUES ($1, $2, $3, 'channel', $4, 'C0ONE')`,
      [conversation, WORKSPACE, agent, TEAM],
    );
    await client.query(
      `INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind)
       VALUES ($1, $2, $3, $4, 'channel')`,
      [topic, WORKSPACE, agent, conversation],
    );
    await client.query(
      `INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq, slack_team_id, slack_channel_id, slack_ts, requester_kind, requester_id, body, buffer_expires_at)
       VALUES ($1, $2, $3, $4, 1, $5, 'C0ONE', '1700000000.000100', 'slack_user', 'U0PERSON', 'held text', now() + interval '5 minutes')`,
      [randomUUID(), WORKSPACE, agent, topic, TEAM],
    );
  }
  return { slackAppId, appId, installationId, identityId, otherAppId };
}

const close = () =>
  db.transaction((tx) =>
    closeSlackApp(tx, {
      workspaceId: WORKSPACE,
      slackAppId: seeded.slackAppId,
      appId: seeded.appId,
      agentId: AGENT,
      closedBy: null,
    }),
  );

async function rows<T>(text: string, params: unknown[] = []) {
  return (await client.query<T>(text, params)).rows;
}

async function snapshot() {
  return {
    installs: await rows(
      "SELECT id, status, revoked_at FROM slack_installations ORDER BY id",
    ),
    identities: await rows(
      "SELECT id, status, revoked_at, revision FROM agent_identities ORDER BY id",
    ),
    bindings: await rows(
      "SELECT id, status, revoked_at, revision FROM surface_bindings ORDER BY id",
    ),
    outbox: await rows(
      "SELECT id, status, error_code FROM slack_outbox ORDER BY id",
    ),
    buffered: await rows("SELECT id FROM conversation_inputs ORDER BY id"),
  };
}

describe("closeSlackApp", () => {
  test("closes the app's installs, identities, bindings, unsent outbox and buffer, and nothing else", async () => {
    expect(await close()).toEqual({
      installations: 1,
      identities: 1,
      bindings: 2,
      outbox: 2,
      buffered: 1,
    });
    expect(
      await rows<{ app_id: string; status: string }>(
        "SELECT app_id, status FROM slack_installations ORDER BY app_id = 'A0OTHER' DESC",
      ),
    ).toEqual([
      { app_id: "A0OTHER", status: "verified" },
      { app_id: seeded.appId, status: "revoked" },
    ]);
    expect(
      await rows("SELECT status FROM agent_identities WHERE id = $1", [
        seeded.identityId,
      ]),
    ).toEqual([{ status: "revoked" }]);
    expect(
      await rows(
        "SELECT external_surface_id AS channel, status FROM surface_bindings ORDER BY external_surface_id",
      ),
    ).toEqual([
      { channel: "C0KEEP", status: "ready" },
      { channel: "C0ONE", status: "revoked" },
      { channel: "C0TWO", status: "revoked" },
    ]);
    const outbox = await rows<{
      app: string;
      status: string;
      error_code: string | null;
    }>(
      "SELECT slack_app_id AS app, status, error_code FROM slack_outbox ORDER BY status, slack_app_id",
    );
    expect(outbox.filter((row) => row.app === seeded.slackAppId)).toEqual([
      { app: seeded.slackAppId, status: "failed", error_code: "app_deleted" },
      { app: seeded.slackAppId, status: "failed", error_code: "app_deleted" },
      { app: seeded.slackAppId, status: "sending", error_code: null },
      { app: seeded.slackAppId, status: "sent", error_code: null },
    ]);
    expect(outbox.filter((row) => row.app === seeded.otherAppId)).toEqual([
      { app: seeded.otherAppId, status: "pending", error_code: null },
    ]);
    expect(await rows("SELECT agent_id FROM conversation_inputs")).toEqual([
      { agent_id: OTHER_AGENT },
    ]);
  });

  test("a second close, and a late uninstall or tokens_revoked, change nothing", async () => {
    await close();
    const before = await snapshot();
    expect(await close()).toEqual({
      installations: 0,
      identities: 0,
      bindings: 0,
      outbox: 0,
      buffered: 0,
    });
    const installs = createPostgresSlackInstallStore(db);
    // Slack retries an event it got no 200 for; each lands the same.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await installs.revokeInstallation(
          { appId: seeded.appId, teamId: TEAM },
          new Date(),
        ),
      ).toBe("revoked");
    }
    expect(await snapshot()).toEqual(before);
  });

  test("a row claimed before the delete is refused at its send", async () => {
    const outbox = createPostgresSlackOutboxStore(db);
    const claimed = await outbox.claim({ limit: 10, leaseMs: 60_000 });
    const mine = claimed.filter((row) => row.slackAppId === seeded.slackAppId);
    expect(mine.length).toBeGreaterThan(0);
    await close();
    for (const row of mine) {
      expect(
        await outbox.beginSend({ id: row.id, claimToken: row.claimToken }),
      ).toBe(false);
    }
    expect(
      (await outbox.claim({ limit: 10, leaseMs: 60_000 })).filter(
        (row) => row.slackAppId === seeded.slackAppId,
      ),
    ).toEqual([]);
  });

  test("a row a running session enqueues after the delete closes as app_deleted", async () => {
    await createPostgresSlackAppStore(db, key).finishDelete({
      workspaceId: WORKSPACE,
      slackAppId: seeded.slackAppId,
      actor: null,
    });
    const late = randomUUID();
    await client.query(
      `INSERT INTO slack_outbox (id, workspace_id, agent_id, slack_app_id, installation_id, kind, channel_id, thread_ts, body, dedupe_key, status)
       VALUES ($1, $2, $3, $4, $5, 'reply', 'C0ONE', '', '{"text":"late"}', $6, 'pending')`,
      [
        late,
        WORKSPACE,
        AGENT,
        seeded.slackAppId,
        seeded.installationId,
        randomUUID(),
      ],
    );
    const outbox = createPostgresSlackOutboxStore(db);
    expect(
      (await outbox.claim({ limit: 10, leaseMs: 60_000 })).map((row) => row.id),
    ).not.toContain(late);
    await outbox.closeUnaddressed();
    expect(
      await rows("SELECT status, error_code FROM slack_outbox WHERE id = $1", [
        late,
      ]),
    ).toEqual([{ status: "failed", error_code: "app_deleted" }]);
  });
});

describe("finishDelete", () => {
  test("closes all in one transaction with a receipt that holds no token", async () => {
    const store = createPostgresSlackAppStore(db, key);
    const bot = `bot-${randomUUID()}`;
    await db.transaction((tx) =>
      writeSecretInTx(
        tx,
        key,
        {
          workspaceId: WORKSPACE,
          owner: { kind: "slack_app", id: seeded.slackAppId },
          purpose: "slack_bot_token",
        },
        bot,
      ),
    );
    const finished = await store.finishDelete({
      workspaceId: WORKSPACE,
      slackAppId: seeded.slackAppId,
      actor: null,
    });
    if (finished.outcome !== "deleted") throw new Error("not deleted");
    expect(finished.botToken).toBe(bot);
    expect(finished.app.state).toBe("deleted");
    expect(finished.closed).toEqual({
      installations: 1,
      identities: 1,
      bindings: 2,
      outbox: 2,
      buffered: 1,
    });
    await store.recordDeleteCleanup(WORKSPACE, finished.receiptId, {
      outcome: "failed",
      failed_steps: ["auth.revoke"],
      message: "clean up in Slack",
    });
    const [receipt] = await rows<{
      operation: string;
      result: Record<string, unknown>;
    }>("SELECT operation, result FROM receipts WHERE id = $1", [
      finished.receiptId,
    ]);
    expect(receipt?.operation).toBe("delete_slack_app");
    expect(receipt?.result).toMatchObject({
      slack_app_id: seeded.slackAppId,
      app_id: seeded.appId,
      agent_id: AGENT,
      closed: finished.closed,
      slack_cleanup: { outcome: "failed", failed_steps: ["auth.revoke"] },
    });
    expect(JSON.stringify(receipt)).not.toContain(bot);
    expect(
      await rows("SELECT 1 FROM secret_values WHERE owner_ref LIKE $1", [
        `%${seeded.slackAppId}%`,
      ]),
    ).toEqual([]);
  });

  test("a failure partway leaves every row as it was", async () => {
    const store = createPostgresSlackAppStore(db, key);
    const before = await snapshot();
    // The receipt insert is the last write; a trigger refuses it.
    await client.exec(`
      CREATE FUNCTION fail_delete_receipt() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'receipt refused'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_delete_receipt BEFORE INSERT ON receipts
        FOR EACH ROW EXECUTE FUNCTION fail_delete_receipt();
      ALTER TABLE receipts ENABLE ALWAYS TRIGGER fail_delete_receipt;`);
    try {
      await expect(
        store.finishDelete({
          workspaceId: WORKSPACE,
          slackAppId: seeded.slackAppId,
          actor: null,
        }),
      ).rejects.toThrow();
    } finally {
      await client.exec(`
        DROP TRIGGER fail_delete_receipt ON receipts;
        DROP FUNCTION fail_delete_receipt();`);
    }
    expect(await snapshot()).toEqual(before);
    expect(
      await rows("SELECT state FROM slack_apps WHERE id = $1", [
        seeded.slackAppId,
      ]),
    ).toEqual([{ state: "created" }]);
  });

  test("a second delete that began alongside finds it done: no second close or receipt", async () => {
    const store = createPostgresSlackAppStore(db, key);
    const input = {
      workspaceId: WORKSPACE,
      slackAppId: seeded.slackAppId,
      actor: null,
    };
    expect((await store.finishDelete(input)).outcome).toBe("deleted");
    const before = await snapshot();
    const second = await store.finishDelete(input);
    expect(second.outcome).toBe("settled");
    expect(second.app.state).toBe("deleted");
    expect(await snapshot()).toEqual(before);
    expect(
      await rows(
        "SELECT count(*)::int AS n FROM receipts WHERE operation = 'delete_slack_app'",
      ),
    ).toEqual([{ n: 1 }]);
  });

  test("an install consent that lands after the delete reopens nothing", async () => {
    await createPostgresSlackAppStore(db, key).finishDelete({
      workspaceId: WORKSPACE,
      slackAppId: seeded.slackAppId,
      actor: null,
    });
    const before = await snapshot();
    const installs = createPostgresSlackInstallStore(db);
    for (const teamId of [TEAM, "T0LATE"]) {
      expect(
        await installs.recordInstallation({
          workspaceId: WORKSPACE,
          appId: seeded.appId,
          teamId,
          botUserId: "U0LATEBOT",
        }),
      ).toEqual({ outcome: "revoked" });
    }
    expect(await snapshot()).toEqual(before);
    expect(
      await rows(
        "SELECT team_id, status FROM slack_installations WHERE app_id = $1 ORDER BY team_id",
        [seeded.appId],
      ),
    ).toEqual([{ team_id: TEAM, status: "revoked" }]);
  });
});
