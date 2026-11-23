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
  slackInstallations,
  surfaceBindings,
  users,
  workspaces,
} from "./schema.ts";
import { lockSessionReach } from "./sessions/requester-locks.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { createPostgresUsageReader } from "./usage/usage-reader.ts";

// sessionVisibleTo on a private channel's sessions (94S-1999): the channel
// the policy found the viewer a member of goes before who made the session,
// and no key sees one, whatever channels it is handed. Since 94S-2052 the
// door is the parent channel's, whatever the share (decision 26).
describe("private_channel sessions on the reads", () => {
  let client: PGlite;
  let db: Database;
  const ws = randomUUID();
  const agentId = randomUUID();
  const privateChannel = randomUUID();
  const publicChannel = randomUUID();
  // A channel no binding names: its kind is not known, so it is held private.
  const unboundChannel = randomUUID();
  const requester = randomUUID();
  const member = randomUUID();
  const ids = {
    privateOne: randomUUID(),
    // No share row: behind the channel's door all the same (94S-2052),
    // before 94S-2001 moves it.
    privateOld: randomUUID(),
    // Its creator's alone, from a private channel: creator and member both.
    privateMine: randomUUID(),
    publicOne: randomUUID(),
    // Its creator's alone, from a public channel: as before.
    publicMine: randomUUID(),
    unboundOne: randomUUID(),
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
    const installationId = randomUUID();
    await db.insert(slackInstallations).values({
      id: installationId,
      workspaceId: ws,
      appId: "A0PC",
      teamId: "T0ACME",
    });
    for (const [channelId, surfaceKind] of [
      ["C0PRIV", "private_channel"],
      ["C0OPEN", "public_channel"],
    ] as const) {
      await db.insert(surfaceBindings).values({
        id: randomUUID(),
        workspaceId: ws,
        agentId,
        surface: "slack",
        installationId,
        externalSurfaceId: channelId,
        surfaceKind,
        mode: "on",
        ceilingActions: [],
        ceilingDisclosure: "summary",
      });
    }
    for (const [id, channelId] of [
      [privateChannel, "C0PRIV"],
      [publicChannel, "C0OPEN"],
      [unboundChannel, "C0NONE"],
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
      [ids.privateMine, privateChannel],
      [ids.publicOne, publicChannel],
      [ids.publicMine, publicChannel],
      [ids.unboundOne, unboundChannel],
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
    for (const [sessionId, scope] of [
      [ids.privateOne, "private_channel"],
      [ids.privateMine, "private"],
      [ids.publicMine, "private"],
    ] as const) {
      await db.insert(sessionShares).values({
        sessionId,
        ownerId: ws,
        workspaceId: ws,
        scope,
      });
    }
  }, 60_000);

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
      .filter((id) => (Object.values(ids) as string[]).includes(id))
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
  const sorted = (...list: string[]) => [...list].sort();

  test("a member of the channel lists it; the list and the count agree", async () => {
    const viewer = {
      userId: member,
      apiKeyId: null,
      privateChannels: [privateChannel],
    };
    const shown = sorted(ids.privateOne, ids.privateOld, ids.publicOne);
    expect(await seen(viewer)).toEqual(shown);
    expect(await counted(viewer)).toBe(shown.length);
  });

  test("the requester out of the channel, and anyone not in it, does not", async () => {
    for (const [userId, open] of [
      [requester, sorted(ids.publicOne, ids.publicMine)],
      [member, [ids.publicOne]],
    ] as [string, string[]][]) {
      const viewer = { userId, apiKeyId: null };
      expect(await seen(viewer)).toEqual(open);
      expect(await counted(viewer)).toBe(open.length);
    }
    expect(
      await seen({
        userId: requester,
        apiKeyId: null,
        privateChannels: [publicChannel],
      }),
    ).toEqual(sorted(ids.publicOne, ids.publicMine));
  });

  // 94S-2052: a private session from a private channel goes through the door
  // first, then its own rule. `before` is what main answered until then.
  test.each([
    ["its creator, a member", requester, [privateChannel], true, true],
    ["its creator, gone from the channel", requester, [], true, false],
    ["another member", member, [privateChannel], false, false],
  ] as const)(
    "a private session from a private channel: %s",
    async (_, userId, privateChannels, _before, after) => {
      const viewer = { userId, apiKeyId: null, privateChannels };
      expect((await seen(viewer)).includes(ids.privateMine)).toBe(after);
    },
  );

  test("a private session from a public channel is seen as before: its creator alone", async () => {
    expect(
      (await seen({ userId: requester, apiKeyId: null })).includes(
        ids.publicMine,
      ),
    ).toBe(true);
    expect(
      (
        await seen({
          userId: member,
          apiKeyId: null,
          privateChannels: [privateChannel, publicChannel],
        })
      ).includes(ids.publicMine),
    ).toBe(false);
  });

  test("a channel whose kind no binding names is held private", async () => {
    expect(
      (await seen({ userId: member, apiKeyId: null })).includes(ids.unboundOne),
    ).toBe(false);
    expect(
      (
        await seen({
          userId: member,
          apiKeyId: null,
          privateChannels: [unboundChannel],
        })
      ).includes(ids.unboundOne),
    ).toBe(true);
  });

  test("no key lists it, its creator a member or not", async () => {
    for (const viewer of [
      {
        userId: member,
        apiKeyId: randomUUID(),
        privateChannels: [privateChannel],
      },
      // The creator's own personal key, the channel handed to it.
      {
        userId: requester,
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
      const shown = await seen(viewer);
      for (const id of [ids.privateOne, ids.privateOld, ids.privateMine]) {
        expect(shown.includes(id)).toBe(false);
      }
    }
  });

  test("the private channel a session came from is read for it, and for the workspace", async () => {
    const shares = createPostgresSessionShareStore(db);
    const place = {
      conversationId: privateChannel,
      agentId,
      channelId: "C0PRIV",
    };
    const unbound = {
      conversationId: unboundChannel,
      agentId,
      channelId: "C0NONE",
      kindUnknown: true as const,
    };
    expect(await shares.privateChannels(ws, ids.privateOne)).toEqual([place]);
    expect(await shares.privateChannels(ws, ids.publicOne)).toEqual([]);
    expect(await shares.privateChannels(ws, ids.publicMine)).toEqual([]);
    // Before 94S-2052 both read [].
    expect(await shares.privateChannels(ws, ids.privateOld)).toEqual([place]);
    expect(await shares.privateChannels(ws, ids.privateMine)).toEqual([place]);
    expect(await shares.privateChannels(ws, ids.unboundOne)).toEqual([unbound]);
    const all = await shares.privateChannels(ws, null);
    expect(
      [...all].sort((a, b) => a.channelId.localeCompare(b.channelId)),
    ).toEqual([unbound, place]);
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

  // Architect: a personal key's totals are its creator's own spending and
  // keep a private channel's sessions, as amounts nothing labels.
  test("a creator's totals, a personal key's included, count it with no label naming it", async () => {
    await db
      .update(sessions)
      .set({ costUsd: 1.25 })
      .where(eq(sessions.id, ids.privateOne));
    const usage = createPostgresUsageReader(db);
    const filter = { kind: "user", ownerId: ws, userId: requester } as const;
    const period = { since: new Date(0) };
    const summary = await usage.usageSummary(filter, period);
    expect(summary.sessionCount).toBe(Object.values(ids).length);
    expect(Number(summary.costUsd)).toBe(1.25);
    const labelled = [
      await usage.usageSummaryGroups(filter, period, "agent"),
      await usage.usageSummaryGroups(filter, period, "user"),
      await usage.usageBreakdown(filter, period, "agent"),
      await usage.usageBreakdown(filter, period, "model"),
      await usage.usageSeries(filter, period),
    ];
    for (const record of labelled) {
      const text = JSON.stringify(record);
      expect(text).not.toContain(ids.privateOne);
      expect(text).not.toContain(privateChannel);
      expect(text).not.toContain("C0PRIV");
    }
  });

  // Under the session row Slack cannot be asked: what the policy confirmed
  // stands for a person, and no key reaches it.
  test("a follow-up or an answer reaches it under the lock as the policy let it", async () => {
    const reach = (
      who: { userId: string | null; apiKeyId: string | null },
      answer = false,
    ) =>
      db.transaction((tx) =>
        lockSessionReach(
          tx as unknown as Database,
          {
            ...who,
            role: "member",
            keyAgentId: null,
            slackBotUserId: null,
          },
          {
            id: ids.privateOne,
            workspaceId: ws,
            createdByUserId: requester,
            createdByApiKeyId: null,
            agentReleaseId: null,
          },
          { answer },
        ),
      );
    expect(await reach({ userId: member, apiKeyId: null })).toBe("ok");
    // Answering stays with the creator, a manager or the agent's admins.
    expect(await reach({ userId: member, apiKeyId: null }, true)).toBe("role");
    expect(await reach({ userId: requester, apiKeyId: null }, true)).toBe("ok");
    expect(await reach({ userId: member, apiKeyId: randomUUID() })).toBe(
      "not_found",
    );
  });

  // Architect (94S-2052): widening one is left as it was, since the door
  // still stands before the wider share.
  test("a private session from a private channel widened to the workspace stays behind the door", async () => {
    const widened = randomUUID();
    await db.insert(sessions).values({
      id: widened,
      ownerId: ws,
      workspaceId: ws,
      repoUrl: "https://example.invalid/repo.git",
      branch: "main",
      createdByUserId: requester,
      parentConversationId: privateChannel,
    });
    await db.insert(sessionShares).values({
      sessionId: widened,
      ownerId: ws,
      workspaceId: ws,
      scope: "private",
      revision: 1,
    });
    const shares = createPostgresSessionShareStore(db);
    const outcome = await shares.set({
      principal: callerFor(
        {
          kind: "user",
          id: requester,
          workspace_id: ws,
          role: "member",
          scopes: [...scopesForRole("member")],
        },
        { kind: "web" },
        randomUUID(),
      ),
      ownerId: ws,
      workspaceId: ws,
      sessionId: widened,
      scope: "workspace",
      userIds: [],
      teamIds: [],
      updatedBy: requester,
      receiptId: randomUUID(),
    });
    expect(outcome.outcome).toBe("changed");
    const sees = (userId: string, privateChannels: string[]) =>
      shares.visibleTo(ws, widened, {
        userId,
        apiKeyId: null,
        privateChannels,
      });
    expect(await sees(member, [privateChannel])).toBe(true);
    expect(await sees(member, [])).toBe(false);
    expect(await sees(requester, [])).toBe(false);
  });

  test("a private session from a private channel reaches only its creator under the lock", async () => {
    const reach = (who: { userId: string | null; apiKeyId: string | null }) =>
      db.transaction((tx) =>
        lockSessionReach(
          tx as unknown as Database,
          { ...who, role: "member", keyAgentId: null, slackBotUserId: null },
          {
            id: ids.privateMine,
            workspaceId: ws,
            createdByUserId: requester,
            createdByApiKeyId: null,
            agentReleaseId: null,
          },
        ),
      );
    expect(await reach({ userId: requester, apiKeyId: null })).toBe("ok");
    expect(await reach({ userId: member, apiKeyId: null })).toBe("not_found");
    expect(await reach({ userId: requester, apiKeyId: randomUUID() })).toBe(
      "not_found",
    );
  });

  // Architect: the admin list is how an audit read finds one, so it keeps
  // the row, as metadata alone.
  test("the admin list keeps it as metadata, with nothing that names its channel or thread", async () => {
    const rows = await createPostgresSessionShareStore(db).listForAdmin(
      ws,
      100,
    );
    const row = rows.find((item) => item.sessionId === ids.privateOne);
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "admissionState",
      "agentReleaseId",
      "createdAt",
      "createdByApiKeyId",
      "createdByUserId",
      "sessionId",
      "shareScope",
      "status",
      "takeoverRequiredAt",
    ]);
    expect(row?.shareScope).toBe("private_channel");
    const text = JSON.stringify(row);
    expect(text).not.toContain(privateChannel);
    expect(text).not.toContain("C0PRIV");
  });
});
