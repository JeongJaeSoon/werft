import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { scopesForRole } from "@werft-ai/contracts";
import { callerFor, type SessionViewer } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresSessionShareStore } from "./musterrolle/session-shares.ts";
import { createPostgresSessionReader } from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  agents,
  channelContexts,
  conversations,
  memberships,
  sessionShares,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

// sessionVisibleTo on a private channel's sessions (94S-1999): the channel
// the policy found the viewer a member of goes before who made the session,
// and no key sees one, whatever channels it is handed.
describe("private_channel sessions on the reads", () => {
  let client: PGlite;
  let db: Database;
  const ws = randomUUID();
  const agentId = randomUUID();
  const privateChannel = randomUUID();
  const publicChannel = randomUUID();
  const requester = randomUUID();
  const member = randomUUID();
  const ids = {
    privateOne: randomUUID(),
    // Made before this change: no share row, read workspace-wide until it is
    // moved (94S-2001).
    privateOld: randomUUID(),
    publicOne: randomUUID(),
  };

  beforeAll(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    await db.insert(workspaces).values({ id: ws, slug: "ws-pc", name: "ws" });
    for (const id of [requester, member]) {
      await db.insert(users).values({
        id,
        email: `${id}@example.invalid`,
        passwordHash: "argon2id$placeholder",
        displayName: "person",
      });
      await db.insert(memberships).values({
        workspaceId: ws,
        userId: id,
        role: "member",
      });
    }
    await db.insert(agents).values({
      id: agentId,
      workspaceId: ws,
      managingTeamId: await fixtureTeam(db, ws),
      slug: "notes",
      name: "notes",
    });
    for (const [id, channelId] of [
      [privateChannel, "C0PRIV"],
      [publicChannel, "C0OPEN"],
    ] as const) {
      await db.insert(channelContexts).values({
        id: randomUUID(),
        workspaceId: ws,
        teamId: "T0ACME",
        channelId,
      });
      await db.insert(conversations).values({
        id,
        workspaceId: ws,
        agentId,
        kind: "channel",
        teamId: "T0ACME",
        channelId,
      });
    }
    for (const [id, parent] of [
      [ids.privateOne, privateChannel],
      [ids.privateOld, privateChannel],
      [ids.publicOne, publicChannel],
    ] as const) {
      await db.insert(sessions).values({
        id,
        ownerId: ws,
        workspaceId: ws,
        repoUrl: "https://example.invalid/repo.git",
        branch: "main",
        createdByUserId: requester,
        parentConversationId: parent,
      });
    }
    await db.insert(sessionShares).values({
      sessionId: ids.privateOne,
      ownerId: ws,
      workspaceId: ws,
      scope: "private_channel",
    });
  });

  afterAll(() => client.close());

  const seen = async (viewer: SessionViewer) =>
    (
      await createPostgresSessionReader(db).listSessions(
        ws,
        { limit: 100 },
        viewer,
      )
    ).items
      .map((item) => item.id)
      .filter((id) => Object.values(ids).includes(id))
      .sort();
  const counted = async (viewer: SessionViewer) => {
    const counts = await createPostgresSessionReader(db).countSessions(
      ws,
      {},
      viewer,
    );
    return Object.values(counts).reduce(
      (sum: number, value) => sum + (typeof value === "number" ? value : 0),
      0,
    );
  };
  const open = [ids.privateOld, ids.publicOne].sort();

  test("a member of the channel lists it; the list and the count agree", async () => {
    const viewer = {
      userId: member,
      apiKeyId: null,
      privateChannels: [privateChannel],
    };
    expect(await seen(viewer)).toEqual(Object.values(ids).sort());
    expect(await counted(viewer)).toBe(3);
  });

  test("the requester out of the channel, and anyone not in it, does not", async () => {
    for (const userId of [requester, member]) {
      const viewer = { userId, apiKeyId: null };
      expect(await seen(viewer)).toEqual(open);
      expect(await counted(viewer)).toBe(2);
    }
    expect(
      await seen({
        userId: requester,
        apiKeyId: null,
        privateChannels: [publicChannel],
      }),
    ).toEqual(open);
  });

  test("no key lists it, its creator a member or not", async () => {
    for (const viewer of [
      {
        userId: member,
        apiKeyId: randomUUID(),
        privateChannels: [privateChannel],
      },
      {
        userId: null,
        apiKeyId: randomUUID(),
        keyAgentId: agentId,
        privateChannels: [privateChannel],
      },
    ]) {
      expect(await seen(viewer)).toEqual(open);
    }
  });

  test("the private channel a session came from is read for it, and for the workspace", async () => {
    const shares = createPostgresSessionShareStore(db);
    const place = {
      conversationId: privateChannel,
      agentId,
      channelId: "C0PRIV",
    };
    expect(await shares.privateChannels(ws, ids.privateOne)).toEqual([place]);
    expect(await shares.privateChannels(ws, ids.publicOne)).toEqual([]);
    expect(await shares.privateChannels(ws, ids.privateOld)).toEqual([]);
    expect(await shares.privateChannels(ws, null)).toEqual([place]);
    expect(await shares.privateChannels(randomUUID(), null)).toEqual([]);
  });

  test("its share is the channel's: changing it is refused and changes nothing", async () => {
    const shares = createPostgresSessionShareStore(db);
    const by = callerFor(
      {
        kind: "user",
        id: requester,
        workspace_id: ws,
        role: "member",
        scopes: [...scopesForRole("member")],
      },
      { kind: "web" },
      randomUUID(),
    );
    const outcome = await shares.set({
      principal: by,
      ownerId: ws,
      workspaceId: ws,
      sessionId: ids.privateOne,
      scope: "workspace",
      userIds: [],
      teamIds: [],
      updatedBy: requester,
      receiptId: randomUUID(),
    });
    expect(outcome).toEqual({ outcome: "channel_fixed" });
    expect(
      await db
        .select({
          scope: sessionShares.scope,
          revision: sessionShares.revision,
        })
        .from(sessionShares)
        .where(eq(sessionShares.sessionId, ids.privateOne)),
    ).toEqual([{ scope: "private_channel", revision: 1 }]);
    expect(await shares.get(ws, ids.privateOne)).toMatchObject({
      scope: "private_channel",
    });
  });
});
