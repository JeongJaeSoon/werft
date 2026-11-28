import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "../schema.ts";
import { agents, apiKeys, memberships, users, workspaces } from "../schema.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import { createPostgresWorkspaceKeyStore } from "./api-keys.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let statements: string[];

beforeEach(async () => {
  client = await migratedPGlite();
  statements = [];
  db = drizzle(client, {
    schema,
    logger: { logQuery: (query) => statements.push(query) },
  });
});

afterEach(async () => {
  await client.close();
});

test("a list names every key's issuer in one statement, departed ones included", async () => {
  const workspaceId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: "acme", name: "Acme" });
  const person = async (
    name: string,
    gone: { account?: boolean; membership?: boolean } = {},
  ) => {
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      email: `${name.toLowerCase()}@example.invalid`,
      displayName: name,
      disabledAt: gone.account ? new Date() : null,
    });
    await db.insert(memberships).values({
      workspaceId,
      userId: id,
      role: "owner",
      disabledAt: gone.membership ? new Date() : null,
    });
    return id;
  };
  const owner = await person("Owner");
  const left = await person("Left", { membership: true });
  const disabled = await person("Disabled", { account: true });
  const agentId = crypto.randomUUID();
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    managingTeamId: await fixtureTeam(db, workspaceId),
    slug: "bot",
    name: "bot",
  });
  const issuers = [owner, left, disabled, null];
  for (const createdByUserId of issuers) {
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      keyHash: crypto.getRandomValues(new Uint8Array(32)),
      ownerId: workspaceId,
      workspaceId,
      scopes: ["sessions:read"],
      kind: "agent",
      agentId,
      createdByUserId,
    });
  }

  statements = [];
  const { items: listed } = await createPostgresWorkspaceKeyStore(db).list(
    workspaceId,
    { personalOf: owner, allAgentKeysFor: ["owner"] },
    { limit: 10 },
  );

  expect(statements).toHaveLength(1);
  expect(
    listed.map((key) => [key.createdByUserId, key.createdByDisplayName]).sort(),
  ).toEqual(
    [
      [owner, "Owner"],
      [left, "Left"],
      [disabled, "Disabled"],
      [null, null],
    ].sort(),
  );
  expect(listed.every((key) => key.lastUsedAt === null)).toBe(true);
});
