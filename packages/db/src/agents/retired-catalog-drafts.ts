import { randomUUID } from "node:crypto";
import {
  type AgentCard,
  agentCardRequestSchema,
  MCP_TOOL_PREFIX,
} from "@werft-ai/contracts";
import { cardContentSha256 } from "@werft-ai/platform";
import { and, eq, max, sql } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { agents, agentVersions, retiredCatalogMcp } from "../schema.ts";

/**
 * A draft card without the retired catalog server: no `capabilities.mcp`,
 * no `per_tool` entry for its tools, and not the credential name it used
 * (`retiredRef`, when migration 0304 recorded the server). `forbidden` and
 * the card's other names stay.
 */
export function withoutRetiredCatalog(
  card: AgentCard,
  retiredRef: string | null,
): AgentCard {
  const server = card.capabilities.mcp?.[0]?.server;
  if (server === undefined) return card;
  const prefix = `${MCP_TOOL_PREFIX}${server}__`;
  const { tool_policy: policy, credential_refs: refs } = card.capabilities;
  const perTool = Object.fromEntries(
    Object.entries(policy?.per_tool ?? {}).filter(
      ([tool]) => !tool.startsWith(prefix),
    ),
  );
  const {
    tool_policy: _policy,
    credential_refs: _refs,
    ...rest
  } = card.capabilities;
  return {
    ...card,
    capabilities: {
      ...rest,
      mcp: null,
      ...(policy === undefined || Object.keys(perTool).length === 0
        ? {}
        : { tool_policy: { per_tool: perTool } }),
      ...(refs === undefined
        ? {}
        : { credential_refs: refs.filter((ref) => ref !== retiredRef) }),
    },
  };
}

export type RetiredCatalogDrafts = {
  /** Drafts moved to a version without the catalog server. */
  moved: number;
  /** Drafts whose stored card no longer parses, left as they are. */
  unreadable: number;
};

/**
 * Moves every draft whose card names a catalog server to a version without
 * it, made for the cleaned card or the agent's version that already holds
 * it; the version a release stands on is never changed. Run at each host
 * start: a draft already moved is not found again, and after 0304 no new
 * one names the catalog.
 */
export async function reconcileRetiredCatalogDrafts(
  db: Database,
): Promise<RetiredCatalogDrafts> {
  const named = await db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(agentVersions, eq(agentVersions.id, agents.draftVersionId))
    .where(sql`card_names_catalog_mcp(${agentVersions.card})`);
  const result: RetiredCatalogDrafts = { moved: 0, unreadable: 0 };
  for (const { id } of named) {
    const outcome = await db.transaction((tx) => cleanDraft(tx, id));
    if (outcome !== "none") result[outcome] += 1;
  }
  return result;
}

async function cleanDraft(
  tx: Database,
  agentId: string,
): Promise<"moved" | "unreadable" | "none"> {
  // The agent row first, as every agent writer takes it.
  const [draft] = await tx
    .select({
      versionId: agents.draftVersionId,
      card: agentVersions.card,
    })
    .from(agents)
    .innerJoin(agentVersions, eq(agentVersions.id, agents.draftVersionId))
    .where(eq(agents.id, agentId))
    .limit(1)
    .for("update", { of: agents });
  if (draft === undefined || draft.versionId === null) return "none";
  const parsed = agentCardRequestSchema.safeParse(draft.card);
  if (!parsed.success) return "unreadable";
  const server = parsed.data.capabilities.mcp?.[0]?.server;
  if (server === undefined) return "none";
  const [retired] = await tx
    .select({ credentialRef: retiredCatalogMcp.credentialRef })
    .from(retiredCatalogMcp)
    .where(eq(retiredCatalogMcp.name, server))
    .limit(1);
  const card = withoutRetiredCatalog(
    parsed.data,
    retired?.credentialRef ?? null,
  );
  const contentSha256 = cardContentSha256(card);
  const [latest] = await tx
    .select({ versionNo: max(agentVersions.versionNo) })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId));
  await tx
    .insert(agentVersions)
    .values({
      id: randomUUID(),
      agentId,
      versionNo: (latest?.versionNo ?? 0) + 1,
      card,
      contentSha256,
    })
    .onConflictDoNothing({
      target: [agentVersions.agentId, agentVersions.contentSha256],
    });
  const [stored] = await tx
    .select({ id: agentVersions.id })
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.agentId, agentId),
        eq(agentVersions.contentSha256, contentSha256),
      ),
    )
    .limit(1);
  if (stored === undefined) {
    throw new Error(`cleaned draft of agent ${agentId} vanished`);
  }
  await tx
    .update(agents)
    .set({
      draftVersionId: stored.id,
      behaviorRevision: sql`${agents.behaviorRevision} + 1`,
      updatedAt: DB_NOW,
    })
    .where(eq(agents.id, agentId));
  return "moved";
}
