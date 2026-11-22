import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { AgentCard } from "@werft-ai/contracts";
import { cardContentSha256 } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { reconcileRetiredCatalogDrafts } from "./agents/retired-catalog-drafts.ts";
import * as schema from "./schema.ts";
import { agentReleases, agents, agentVersions, workspaces } from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { beforeCatalogRetired } from "./testing/retired-catalog.ts";
import { releaseSpecColumns, TEST_CONNECTION_ID } from "./testing/spec-pins.ts";

const RETIRED = {
  name: "docs",
  url: "https://docs.example.invalid/mcp",
  credentialRef: "docs-ref",
};

const CATALOG_CARD: AgentCard = {
  language: "follow-user",
  model: "claude-sonnet-5",
  rules: [],
  capabilities: {
    mcp: [{ server: "docs" }],
    forbidden: ["mcp__docs__drop"],
    tool_policy: {
      per_tool: {
        mcp__docs__read: "allow",
        mcp__docs__drop: "deny",
        mcp__wiki__read: "ask",
      },
    },
    credential_refs: ["docs-ref", "other-ref"],
  },
};

const CLEANED: AgentCard = {
  ...CATALOG_CARD,
  capabilities: {
    mcp: null,
    forbidden: ["mcp__docs__drop"],
    tool_policy: { per_tool: { mcp__wiki__read: "ask" } },
    credential_refs: ["other-ref"],
  },
};

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

// An agent whose draft is the version its active release stands on, both
// made before migration 0303 with a card naming the catalog server.
async function agentOnCatalogDraft(card: AgentCard = CATALOG_CARD) {
  const workspaceId = randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: "acme", name: "acme" });
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    managingTeamId: await fixtureTeam(db, workspaceId),
    slug: "bot",
    name: "bot",
  });
  const versionId = randomUUID();
  const releaseId = `rel-${randomUUID()}`;
  const cardSha256 = cardContentSha256(card);
  await beforeCatalogRetired(db, RETIRED, async () => {
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card,
      contentSha256: cardSha256,
    });
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256,
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: { tools: [], mcp: [] },
    });
    await db
      .update(agents)
      .set({
        activeReleaseId: releaseId,
        activationRevision: 1,
        draftVersionId: versionId,
        draftConnectionId: TEST_CONNECTION_ID,
      })
      .where(eq(agents.id, agentId));
  });
  return { agentId, versionId, releaseId, cardSha256 };
}

const agentRow = async (agentId: string) => {
  const [row] = await db
    .select({
      draftVersionId: agents.draftVersionId,
      behaviorRevision: agents.behaviorRevision,
    })
    .from(agents)
    .where(eq(agents.id, agentId));
  return row;
};

const versionOf = async (id: string | null | undefined) => {
  const [row] = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.id, id ?? randomUUID()));
  return row;
};

describe("reconciling drafts that name a retired catalog server", () => {
  test("the draft moves to a new version without the server, its pins or its name; the release's version stays", async () => {
    const { agentId, versionId, releaseId, cardSha256 } =
      await agentOnCatalogDraft();
    const before = await agentRow(agentId);

    expect(await reconcileRetiredCatalogDrafts(db)).toEqual({
      moved: 1,
      unreadable: 0,
    });

    const after = await agentRow(agentId);
    expect(after?.draftVersionId).not.toBe(versionId);
    expect(after?.behaviorRevision).toBe((before?.behaviorRevision ?? 0) + 1);
    const draft = await versionOf(after?.draftVersionId);
    expect(draft?.card).toEqual(CLEANED);
    expect(draft?.contentSha256).toBe(cardContentSha256(CLEANED));
    expect(draft?.versionNo).toBe(2);
    expect((await versionOf(versionId))?.card).toEqual(CATALOG_CARD);
    const [release] = await db
      .select({ cardSha256: agentReleases.cardSha256 })
      .from(agentReleases)
      .where(eq(agentReleases.id, releaseId));
    expect(release?.cardSha256).toBe(cardSha256);
  });

  test("a second run moves nothing", async () => {
    const { agentId } = await agentOnCatalogDraft();
    await reconcileRetiredCatalogDrafts(db);
    const moved = await agentRow(agentId);
    expect(await reconcileRetiredCatalogDrafts(db)).toEqual({
      moved: 0,
      unreadable: 0,
    });
    expect(await agentRow(agentId)).toEqual(moved);
  });

  test("the agent's version that already holds the cleaned card is the one used", async () => {
    const { agentId } = await agentOnCatalogDraft();
    const kept = randomUUID();
    await db.insert(agentVersions).values({
      id: kept,
      agentId,
      versionNo: 2,
      card: CLEANED,
      contentSha256: cardContentSha256(CLEANED),
    });
    await reconcileRetiredCatalogDrafts(db);
    expect((await agentRow(agentId))?.draftVersionId).toBe(kept);
  });

  test("a server 0303 did not record keeps the card's names", async () => {
    const card: AgentCard = {
      ...CATALOG_CARD,
      capabilities: { ...CATALOG_CARD.capabilities, mcp: [{ server: "gone" }] },
    };
    const { agentId } = await agentOnCatalogDraft(card);
    await reconcileRetiredCatalogDrafts(db);
    const draft = await versionOf((await agentRow(agentId))?.draftVersionId);
    expect(draft?.card).toMatchObject({
      capabilities: { mcp: null, credential_refs: ["docs-ref", "other-ref"] },
    });
  });

  test("a release of the cleaned draft is written; one of the old version is still refused", async () => {
    const { agentId, versionId } = await agentOnCatalogDraft();
    await reconcileRetiredCatalogDrafts(db);
    const draftVersionId = (await agentRow(agentId))?.draftVersionId ?? "";
    const release = async (id: string, version: string) =>
      await db.insert(agentReleases).values({
        id,
        agentId,
        versionId: version,
        cardSha256: "0".repeat(64),
        connectionId: TEST_CONNECTION_ID,
        ...releaseSpecColumns(),
        runtimeConfigSnapshot: {},
        effectiveTools: { tools: [], mcp: [] },
      });
    await release(`rel-${randomUUID()}`, draftVersionId);
    await expect(release(`rel-${randomUUID()}`, versionId)).rejects.toThrow();
  });
});
