import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { enqueueModelMoveNotices } from "./model-move-notices.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  agentAdmins,
  agents,
  linkedAccounts,
  memberships,
  memberTeams,
  slackApps,
  slackInstallations,
  slackOutbox,
  users,
  workspaces,
} from "./schema.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

const NOW = new Date("2026-11-09T00:00:00Z");

async function world() {
  const workspaceId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const teamId = crypto.randomUUID();
  const appRowId = crypto.randomUUID();
  const appId = `A${appRowId.slice(0, 8).toUpperCase()}`;
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
  await db
    .insert(memberTeams)
    .values({ id: teamId, workspaceId, name: "managers" });
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    managingTeamId: teamId,
    slug: `a-${agentId.slice(0, 8)}`,
    name: "재무 분석가",
  });
  await db.insert(slackApps).values({
    id: appRowId,
    workspaceId,
    kind: "agent",
    agentId,
    state: "created",
    appId,
    clientId: `1.${appRowId.slice(0, 8)}`,
    redirectUrl: "https://example.invalid/slack/callback",
    eventsState: "verified",
  });
  await db.insert(slackInstallations).values({
    id: crypto.randomUUID(),
    workspaceId,
    appId,
    teamId: "T1",
    status: "verified",
    botUserId: "UBOT",
    verifiedAt: NOW,
  });
  const admin = async (label: string, locale: "ko" | "en" | "ja") => {
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: label,
      locale,
    });
    await db
      .insert(memberships)
      .values({ workspaceId, userId, role: "member" });
    await db.insert(linkedAccounts).values({
      id: crypto.randomUUID(),
      workspaceId,
      userId,
      provider: "slack",
      externalTenant: "T1",
      externalUserId: `U${label.toUpperCase()}`,
      status: "active",
      verifiedVia: "slack_oidc",
      verifiedAt: NOW,
    });
    await db.insert(agentAdmins).values({ workspaceId, agentId, userId });
    return `U${label.toUpperCase()}`;
  };
  return { workspaceId, agentId, admin };
}

const move = {
  from: "claude-sonnet-5-0",
  to: "claude-sonnet-5-1",
} as const;

describe("enqueueModelMoveNotices", () => {
  test("tells each administrator in their language, as a direct message", async () => {
    const w = await world();
    const ko = await w.admin("ko", "ko");
    const en = await w.admin("en", "en");
    expect(
      await enqueueModelMoveNotices(db, {
        workspaceId: w.workspaceId,
        agentId: w.agentId,
        kind: "moved",
        ...move,
        revision: 3,
      }),
    ).toBe(2);
    const rows = await db.select().from(slackOutbox);
    expect(rows.map((row) => row.channelId).sort()).toEqual([en, ko].sort());
    for (const row of rows) {
      expect(row.kind).toBe("model_notice");
      expect(row.threadTs).toBe("");
      expect(row.sessionId).toBeNull();
      expect(row.body.text).toContain("재무 분석가");
      expect(row.body.text).toContain(move.to);
    }
    const english = rows.find((row) => row.channelId === en);
    expect(english?.body.text).toContain("moved to claude-sonnet-5-1");
  });

  test("one failure repeated at one revision tells once; a later revision tells again", async () => {
    const w = await world();
    await w.admin("one", "en");
    const failed = (revision: number) =>
      enqueueModelMoveNotices(db, {
        workspaceId: w.workspaceId,
        agentId: w.agentId,
        kind: "failed",
        ...move,
        revision,
      });
    expect(await failed(3)).toBe(1);
    expect(await failed(3)).toBe(0);
    expect(await failed(4)).toBe(1);
  });

  test("a failure notice does not hold back the notice of a move that works", async () => {
    const w = await world();
    await w.admin("one", "en");
    const base = {
      workspaceId: w.workspaceId,
      agentId: w.agentId,
      ...move,
      revision: 3,
    };
    expect(await enqueueModelMoveNotices(db, { ...base, kind: "failed" })).toBe(
      1,
    );
    expect(await enqueueModelMoveNotices(db, { ...base, kind: "moved" })).toBe(
      1,
    );
  });

  test("an agent that is gone tells nobody", async () => {
    const w = await world();
    await w.admin("one", "en");
    expect(
      await enqueueModelMoveNotices(db, {
        workspaceId: w.workspaceId,
        agentId: crypto.randomUUID(),
        kind: "moved",
        ...move,
        revision: 1,
      }),
    ).toBe(0);
  });
});
