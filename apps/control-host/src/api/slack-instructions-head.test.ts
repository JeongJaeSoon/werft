import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresDecisionLog,
  memberships,
  users,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import {
  type AgentRecord,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  createInstructionsHeadService,
  type GitHubReleaseRead,
  SessionServiceError,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";

describe("the branch head read over the real policy (a1/S3)", () => {
  let pool: PGlite;
  let db: schema.Database;
  let heads: ReturnType<typeof createInstructionsHeadService>;
  const workspaceId = crypto.randomUUID();
  const agents = { a: crypto.randomUUID(), b: crypto.randomUUID() };
  const repositoryOf = { [agents.a]: "repo-a", [agents.b]: "repo-b" };
  const ids = {
    owner: crypto.randomUUID(),
    admin: crypto.randomUUID(),
    adminOfA: crypto.randomUUID(),
    adminOfB: crypto.randomUUID(),
    member: crypto.randomUUID(),
  };
  const reads: GitHubReleaseRead[] = [];

  function user(who: keyof typeof ids, role: WorkspaceRole): Caller {
    return callerFor(
      {
        kind: "user",
        id: ids[who],
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      crypto.randomUUID(),
    );
  }

  beforeAll(async () => {
    pool = await migratedPGlite();
    db = drizzle(pool, { schema }) as unknown as schema.Database;
    heads = createInstructionsHeadService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
        agents: createDatabaseAgentAuthority(db),
        decisions: createPostgresDecisionLog(db),
      }),
      agents: {
        get: async (_workspaceId, agentId) =>
          agentId in repositoryOf
            ? ({
                active_release: {
                  instructions_snapshot: {
                    kind: "absent",
                    repository_id: repositoryOf[agentId],
                    commit: "a".repeat(40),
                  },
                },
              } as unknown as AgentRecord)
            : null,
      },
      heads: {
        branchHead: async (read) => {
          reads.push(read);
          return { kind: "head", commit: "b".repeat(40) };
        },
      },
    });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "heads", name: "Heads" });
    for (const [who, id] of Object.entries(ids)) {
      await db.insert(users).values({
        id,
        email: `${who.toLowerCase()}@example.com`,
        displayName: who,
      });
      await db.insert(memberships).values({
        workspaceId,
        userId: id,
        role: who === "owner" ? "owner" : who === "admin" ? "admin" : "member",
      });
    }
    const managingTeamId = await fixtureTeam(db, workspaceId);
    for (const [slug, agentId, adminId] of [
      ["agent-a", agents.a, ids.adminOfA],
      ["agent-b", agents.b, ids.adminOfB],
    ] as const) {
      await db
        .insert(schema.agents)
        .values({ id: agentId, workspaceId, managingTeamId, slug, name: slug });
      await db
        .insert(schema.agentAdmins)
        .values({ workspaceId, agentId, userId: adminId });
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.close();
  });

  test("owner, admin and the agent's admin read its repository's head", async () => {
    for (const caller of [
      user("owner", "owner"),
      user("admin", "admin"),
      user("adminOfA", "member"),
    ]) {
      reads.length = 0;
      expect(await heads.getSlackInstructionsHead(caller, agents.a)).toEqual({
        state: "read",
        commit: "b".repeat(40),
        newer: true,
      });
      expect(reads.map((read) => read.repositoryId)).toEqual(["repo-a"]);
    }
  });

  test("an agent this workspace does not have is NOT_FOUND, even for its owner", async () => {
    reads.length = 0;
    const missing = await heads
      .getSlackInstructionsHead(user("owner", "owner"), crypto.randomUUID())
      .catch((error: unknown) => error);
    expect((missing as SessionServiceError).code).toBe("NOT_FOUND");
    expect(reads).toEqual([]);
  });

  test("a member, or another agent's admin, is refused before GitHub is read", async () => {
    for (const caller of [
      user("member", "member"),
      user("adminOfB", "member"),
    ]) {
      reads.length = 0;
      const refused = await heads
        .getSlackInstructionsHead(caller, agents.a)
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(SessionServiceError);
      expect((refused as SessionServiceError).code).toBe("FORBIDDEN");
      expect(reads).toEqual([]);
    }
  });
});
