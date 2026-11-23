import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sessionVisibleTo } from "./musterrolle/session-shares.ts";
import { createPostgresSurfaceBindingStore } from "./musterrolle/surface-bindings.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  channelSessionPlaces,
  readChannelScopePlan,
} from "./sessions/private-channel-scope.ts";
import { makeFixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/**
 * 94S-2001: sessions from private channels made before private_channel
 * existed are moved by the operator command, through the same store call a
 * conversion event makes.
 */
integration(
  "private channel sessions move to private_channel on PostgreSQL",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: Database;

    beforeAll(async () => {
      database = await createTempDatabase({ prefix: "private_channel_scope" });
      pool = new Pool({ connectionString: database.url, max: 4 });
      db = drizzle(pool, { schema }) as unknown as Database;
    }, 60_000);

    afterAll(async () => {
      await pool?.end();
      await database?.drop();
    }, 60_000);

    test("plan writes nothing; apply moves the three private ones, keeps private and public ones, and runs again to the same end", async () => {
      const workspaceId = randomUUID();
      const installationId = randomUUID();
      const creator = randomUUID();
      const named = randomUUID();
      const releaseId = await makeFixtureRelease(db, {
        workspaceId,
        model: TEST_MODEL,
      });
      const { rows: releases } = await pool.query<{ agent_id: string }>(
        "SELECT agent_id FROM agent_releases WHERE id = $1",
        [releaseId],
      );
      const agentId = releases[0]?.agent_id as string;
      for (const user of [creator, named]) {
        await pool.query(
          "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
          [user, `${user}@example.invalid`],
        );
        await pool.query(
          "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
          [workspaceId, user],
        );
      }
      await pool.query(
        "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, $3, 'T1')",
        [installationId, workspaceId, `A${installationId.slice(0, 8)}`],
      );
      const binding = async (kind: string, channel: string) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface, installation_id,
           external_surface_id, surface_kind, mode, ceiling_actions, ceiling_disclosure, status)
         VALUES ($1, $2, $3, 'slack', $4, $5, $6, 'on', '{}', 'full', 'ready')`,
          [id, workspaceId, agentId, installationId, channel, kind],
        );
        return id;
      };
      const privateBinding = await binding("private_channel", "G1");
      // Bound while public; Slack says private now.
      const flipped = await binding("public_channel", "G2");
      const publicBinding = await binding("public_channel", "C1");
      let thread = 0;
      const session = async (
        bindingId: string,
        channel: string,
        options: { revoked?: boolean; scope?: string } = {},
      ) => {
        const id = randomUUID();
        thread += 1;
        await pool.query(
          `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id, created_by_user_id)
         VALUES ($1, $2::text, 'https://example.invalid/repo.git', $3, $2::uuid, $4)`,
          [id, workspaceId, `session/${id}`, creator],
        );
        const ts = `${1000 + thread}.000100`;
        await pool.query(
          `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id,
           surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id,
           release_id, revoked_at)
         VALUES ($1, $2::uuid, $2::text, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)`,
          [
            randomUUID(),
            workspaceId,
            id,
            installationId,
            bindingId,
            `${channel}:${ts}`,
            channel,
            ts,
            agentId,
            releaseId,
            options.revoked ? new Date() : null,
          ],
        );
        if (options.scope !== undefined) {
          await pool.query(
            "INSERT INTO session_shares (session_id, owner_id, workspace_id, scope) VALUES ($1, $2::text, $2::uuid, $3)",
            [id, workspaceId, options.scope],
          );
        }
        return id;
      };
      const open = await session(privateBinding, "G1");
      const revoked = await session(privateBinding, "G1", { revoked: true });
      const stillPublic = await session(flipped, "G2");
      const narrowed = await session(privateBinding, "G1", {
        scope: "private",
      });
      const shared = await session(privateBinding, "G1", { scope: "people" });
      const publicOne = await session(publicBinding, "C1");
      await pool.query(
        "INSERT INTO session_share_targets (id, workspace_id, session_id, user_id) VALUES ($1, $2, $3, $4)",
        [randomUUID(), workspaceId, shared, named],
      );
      await pool.query(
        "INSERT INTO turns (session_id, sequence, message, status, requester_kind) VALUES ($1, 1, 'hi', 'completed', 'api_key')",
        [open],
      );

      const scopes = async () => {
        const { rows } = await pool.query<{ id: string; scope: string }>(
          `SELECT s.id, coalesce(sh.scope, 'workspace') AS scope FROM sessions s
         LEFT JOIN session_shares sh ON sh.session_id = s.id WHERE s.workspace_id = $1`,
          [workspaceId],
        );
        return Object.fromEntries(rows.map((row) => [row.id, row.scope]));
      };
      // Everything a run could write, counted the same way before and after.
      const totals = async () =>
        (
          await pool.query(
            `SELECT
             (SELECT count(*) FROM session_shares WHERE workspace_id = $1) AS shares,
             (SELECT string_agg(scope, ',' ORDER BY session_id) FROM session_shares WHERE workspace_id = $1) AS share_scopes,
             (SELECT sum(revision) FROM session_shares WHERE workspace_id = $1) AS share_revisions,
             (SELECT count(*) FROM session_share_targets WHERE workspace_id = $1) AS targets,
             (SELECT count(*) FROM sessions WHERE workspace_id = $1 AND parent_conversation_id IS NULL) AS orphans,
             (SELECT count(*) FROM conversations WHERE workspace_id = $1) AS conversations,
             (SELECT string_agg(surface_kind || ':' || status || ':' || revision, ',' ORDER BY id) FROM surface_bindings WHERE workspace_id = $1) AS bindings,
             (SELECT count(*) FROM receipts WHERE owner_id = $1::text) AS receipts`,
            [workspaceId],
          )
        ).rows[0];
      const ids = [open, revoked, stillPublic, narrowed, shared, publicOne];
      const visible = async (viewer: Parameters<typeof sessionVisibleTo>[1]) =>
        (
          await db
            .select({ id: schema.sessions.id })
            .from(schema.sessions)
            .where(
              and(
                inArray(schema.sessions.id, ids),
                sessionVisibleTo(db, viewer),
              ),
            )
        )
          .map((row) => row.id)
          .sort();
      const agentKey = {
        userId: null,
        apiKeyId: randomUUID(),
        keyAgentId: agentId,
      };

      const places = await channelSessionPlaces(db, { agentId });
      expect(places.map((place) => place.channelId).sort()).toEqual([
        "C1",
        "G1",
        "G2",
      ]);
      const kindOf = (channelId: string) =>
        channelId === "C1" ? "public_channel" : "private_channel";
      // Before: the agent's key reads every one of them.
      expect(await visible(agentKey)).toEqual([...ids].sort());

      const before = await totals();
      for (const place of places) {
        const { plan } = await readChannelScopePlan(
          db,
          place,
          kindOf(place.channelId),
        );
        if (place.channelId === "G1") {
          expect(plan.moves.map((move) => move.sessionId).sort()).toEqual(
            [open, revoked, shared].sort(),
          );
          expect(plan.keptPrivate).toEqual([narrowed]);
        }
      }
      expect(await totals()).toEqual(before);

      const store = createPostgresSurfaceBindingStore(db);
      const apply = async () => {
        const results: Record<string, unknown> = {};
        for (const place of places) {
          results[place.channelId] = await store.channelKindChanged(
            place,
            async () => kindOf(place.channelId),
          );
        }
        return results;
      };
      const first = await apply();
      expect(first.G2).toMatchObject({
        binding: "now_private",
        moves: [
          { sessionId: stillPublic, from: "workspace", to: "private_channel" },
        ],
      });
      expect(first.C1).toMatchObject({ binding: "unchanged", moves: [] });
      expect(await scopes()).toEqual({
        [open]: "private_channel",
        [revoked]: "private_channel",
        [stillPublic]: "private_channel",
        [narrowed]: "private",
        [shared]: "private_channel",
        [publicOne]: "workspace",
      });
      // The named row stays; under private_channel it grants nothing.
      const { rows: targets } = await pool.query(
        "SELECT user_id FROM session_share_targets WHERE session_id = $1",
        [shared],
      );
      expect(targets).toEqual([{ user_id: named }]);
      const { rows: flippedNow } = await pool.query(
        "SELECT surface_kind, status, home FROM surface_bindings WHERE id = $1",
        [flipped],
      );
      expect(flippedNow).toEqual([
        {
          surface_kind: "private_channel",
          status: "pending_approval",
          home: false,
        },
      ]);
      const { rows: receipts } = await pool.query(
        `SELECT operation, result->>'reason' AS reason FROM receipts
       WHERE target_ref->'resource'->>'id' = $1`,
        [flipped],
      );
      expect(receipts).toEqual([
        { operation: "request_surface_binding", reason: "channel_now_private" },
      ]);
      // Every moved session hangs off its channel's conversation.
      const { rows: parents } = await pool.query<{
        id: string;
        channel_id: string;
      }>(
        `SELECT s.id, c.channel_id FROM sessions s JOIN conversations c
         ON c.id = s.parent_conversation_id WHERE s.id = ANY($1::uuid[])`,
        [[open, revoked, stillPublic, shared]],
      );
      expect(parents).toHaveLength(4);
      const g1 = parents.find((row) => row.channel_id === "G1");
      const g1Conversation = (
        await pool.query<{ id: string }>(
          "SELECT id FROM conversations WHERE workspace_id = $1 AND channel_id = 'G1'",
          [workspaceId],
        )
      ).rows[0]?.id as string;
      expect(g1).toBeDefined();

      // After: no key reaches a moved one; the creator sees them only as a
      // member of the channel, and the narrowed one stays theirs.
      expect(await visible(agentKey)).toEqual([narrowed, publicOne].sort());
      expect(await visible({ userId: creator, apiKeyId: null })).toEqual(
        [narrowed, publicOne].sort(),
      );
      expect(
        await visible({
          userId: creator,
          apiKeyId: null,
          privateChannels: [g1Conversation],
        }),
      ).toEqual([open, revoked, shared, narrowed, publicOne].sort());

      // Twice: nothing more moves and nothing is written.
      const settled = await totals();
      const second = await apply();
      for (const result of Object.values(second)) {
        expect(result).toMatchObject({
          binding: "unchanged",
          moves: [],
          skipped: [],
        });
      }
      expect(await totals()).toEqual(settled);

      // The channel turned public: its sessions are the workspace's again,
      // and the binding is ready as a public channel's.
      const g1Place = places.find((place) => place.channelId === "G1");
      if (g1Place === undefined) throw new Error("no G1 place");
      const back = await store.channelKindChanged(
        g1Place,
        async () => "public_channel",
      );
      expect(back?.binding).toBe("now_public");
      expect((await scopes())[open]).toBe("workspace");
      expect((await scopes())[shared]).toBe("workspace");
      expect((await scopes())[narrowed]).toBe("private");
      const { rows: g1Binding } = await pool.query(
        "SELECT surface_kind, status FROM surface_bindings WHERE id = $1",
        [privateBinding],
      );
      expect(g1Binding).toEqual([
        { surface_kind: "public_channel", status: "ready" },
      ]);

      // A share change holding the session row, as setShare does, is waited
      // for; the move reads what it left and keeps the narrowed one private.
      const holder = await pool.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
        open,
      ]);
      await holder.query(
        "UPDATE session_shares SET scope = 'private', revision = revision + 1 WHERE session_id = $1",
        [open],
      );
      const racing = store.channelKindChanged(
        g1Place,
        async () => "private_channel",
      );
      await Bun.sleep(300);
      await holder.query("COMMIT");
      holder.release();
      const raced = await racing;
      expect(raced?.keptPrivate).toContain(open);
      expect(raced?.moves.map((move) => move.sessionId)).not.toContain(open);
      expect((await scopes())[open]).toBe("private");
      expect((await scopes())[shared]).toBe("private_channel");

      // Going public again widens only the channel's own sessions: one whose
      // parent is another channel's conversation keeps that channel.
      const g2Conversation = (
        await pool.query<{ id: string }>(
          "SELECT id FROM conversations WHERE workspace_id = $1 AND channel_id = 'G2'",
          [workspaceId],
        )
      ).rows[0]?.id as string;
      await pool.query(
        "UPDATE sessions SET parent_conversation_id = $2 WHERE id = $1",
        [shared, g2Conversation],
      );
      const widened = await store.channelKindChanged(
        g1Place,
        async () => "public_channel",
      );
      expect(widened?.skipped).toEqual([
        { sessionId: shared, reason: "no_channel_conversation" },
      ]);
      expect((await scopes())[shared]).toBe("private_channel");
      expect((await scopes())[revoked]).toBe("workspace");

      // Two conversions racing: the second waits on the channel before it
      // asks Slack, so the later answer is the one written.
      let answerFirst: (kind: "public_channel") => void = () => {};
      const firstAsked = new Promise<"public_channel">((resolve) => {
        answerFirst = resolve;
      });
      let secondAsked = false;
      const earlier = store.channelKindChanged(g1Place, () => firstAsked);
      await Bun.sleep(200);
      const later = store.channelKindChanged(g1Place, async () => {
        secondAsked = true;
        return "private_channel";
      });
      await Bun.sleep(300);
      expect(secondAsked).toBe(false);
      answerFirst("public_channel");
      await earlier;
      expect((await later)?.binding).toBe("now_private");
      expect((await scopes())[revoked]).toBe("private_channel");
      const { rows: settledBinding } = await pool.query(
        "SELECT surface_kind FROM surface_bindings WHERE id = $1",
        [privateBinding],
      );
      expect(settledBinding).toEqual([{ surface_kind: "private_channel" }]);

      // Unconfirmed: nothing is written.
      const quiet = await totals();
      expect(await store.channelKindChanged(g1Place, async () => null)).toBe(
        null,
      );
      expect(await totals()).toEqual(quiet);

      // The session rows come before the binding: a transaction holding a
      // session and then taking the binding is waited for, not deadlocked.
      const input = await pool.connect();
      await input.query("BEGIN");
      await input.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
        revoked,
      ]);
      const converting = store.channelKindChanged(
        g1Place,
        async () => "public_channel",
      );
      await Bun.sleep(300);
      await input.query(
        "SELECT id FROM surface_bindings WHERE id = $1 FOR UPDATE",
        [privateBinding],
      );
      await input.query("COMMIT");
      input.release();
      expect((await converting)?.binding).toBe("now_public");
    });
  },
);
