import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AgentCallerLimitRule,
  GITHUB_MCP_FIXED_TOOLS,
  githubMcpToolNames,
  type SessionScope,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type Caller,
  type CallerLimitDimension,
  callerFor,
  type TeamActor,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentCallerLimitsStore } from "./agent-caller-limits.ts";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresTeamStore } from "./member-teams.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentGitHubSettings,
  agentMcpSettings,
  agentReleases,
  agents,
  agentVersions,
  authzDecisions,
  catalogRepositories,
  memberships,
  sessions,
  turns,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];
const LIMITS = { queuedInputLimitPerSession: 10_000, storageLimitBytes: 1e15 };
const SCOPES: SessionScope[] = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
];

integration("caller limits on session create and input", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "caller_limit_it" });
    pool = new Pool({ connectionString: database.url, max: 32 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const uow = () => createPostgresSessionUnitOfWork(db);
  const teams = () => createPostgresTeamStore(db);
  const limits = () => createPostgresAgentCallerLimitsStore(db);

  const idOf = (caller: Caller) => caller.actor?.userId ?? "";
  const acting = (caller: Caller): TeamActor => ({
    principal: caller,
    workspaceId: caller.ownerId,
    userId: idOf(caller),
  });

  async function workspace() {
    const id = randomUUID();
    const slug = `ws-${id.slice(0, 8)}`;
    await db.insert(workspaces).values({
      id,
      slug,
      name: slug,
      settings: { agent_outsider_session_visibility: "workspace" },
    });
    return id;
  }

  async function person(workspaceId: string, role: WorkspaceRole = "member") {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...SCOPES, ...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  async function repository() {
    const id = `repo-${randomUUID().slice(0, 8)}`;
    await db.insert(catalogRepositories).values({
      id,
      owner: "o",
      name: id,
      url: `https://example.invalid/o/${id}`,
      branch: "main",
      source: "seed",
    });
    return { id, url: `https://example.invalid/o/${id}`, branch: "main" };
  }

  async function agentRelease(
    workspaceId: string,
    options: {
      credentialRefs?: string[];
      tools?: string[];
      mcp?: string[];
      snapshotTools?: string[];
    } = {},
  ) {
    const agentId = randomUUID();
    const managingTeamId = await fixtureTeam(db, workspaceId);
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId,
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
    });
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card: {
        capabilities: { credential_refs: options.credentialRefs ?? [] },
      },
      contentSha256: "a".repeat(64),
    });
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "a".repeat(64),
      runtimeProfileId: "coding",
      profileDigest: "digest",
      runtimeConfigSnapshot: { tools: options.snapshotTools ?? [] },
      effectiveTools: { tools: options.tools ?? [], mcp: options.mcp ?? [] },
    });
    await db
      .update(agents)
      .set({
        status: "active",
        activeReleaseId: releaseId,
        activationRevision: 1,
      })
      .where(eq(agents.id, agentId));
    return { agentId, releaseId, managingTeamId, versionId };
  }

  const create = (
    by: Caller,
    releaseId: string,
    extra: {
      idempotencyKey?: string;
      repository?: { id: string; url: string; branch: string };
      callerLimited?: CallerLimitDimension;
      githubPolicySource?: "release" | "agent";
    } = {},
  ) =>
    uow().acceptInputAtomic({
      ...(extra.githubPolicySource
        ? { githubPolicySource: extra.githubPolicySource }
        : {}),
      principal: by,
      callerSubject: by.subject,
      idempotencyKey: extra.idempotencyKey ?? randomUUID(),
      payloadHash: "create",
      profileId: "coding",
      repository: extra.repository ?? "none",
      agentReleaseId: releaseId,
      message: "start",
      limits: LIMITS,
      ...(extra.callerLimited ? { callerLimited: extra.callerLimited } : {}),
    });

  async function session(
    by: Caller,
    releaseId: string,
    repo?: { id: string; url: string; branch: string },
  ) {
    const created = await create(
      by,
      releaseId,
      repo ? { repository: repo } : {},
    );
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    return created.response.session_id;
  }

  const append = (
    by: Caller,
    sessionId: string,
    extra: { profileTools?: string[]; idempotencyKey?: string } = {},
  ) =>
    uow().appendInputAtomic({
      principal: by,
      callerSubject: by.subject,
      sessionId,
      idempotencyKey: extra.idempotencyKey ?? randomUUID(),
      payloadHash: "append",
      message: "more",
      limits: LIMITS,
      ...(extra.profileTools ? { profileTools: extra.profileTools } : {}),
    });

  async function team(by: Caller, people: Caller[]) {
    const created = await teams().create({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId: randomUUID(),
      name: `team-${randomUUID()}`,
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    for (const who of people) {
      await teams().addMember({
        actor: acting(by),
        receiptId: randomUUID(),
        teamId: created.team.id,
        userId: idOf(who),
      });
    }
    return created.team.id;
  }

  async function setRules(
    by: Caller,
    agentId: string,
    rules: AgentCallerLimitRule[],
  ) {
    const current = await limits().get(by.ownerId, agentId);
    const result = await limits().put({
      actor: acting(by),
      receiptId: randomUUID(),
      agentId,
      rules,
      ifMatch: current?.revision ?? 1,
      managerRoles: MANAGERS,
    });
    expect(["set", "unchanged"]).toContain(result.outcome);
  }

  const rule = (
    target: AgentCallerLimitRule["target"],
    patch: Partial<Omit<AgentCallerLimitRule, "target">> = {},
  ): AgentCallerLimitRule => ({
    target,
    tools_deny: [],
    repositories: null,
    mcp_servers: null,
    credentials_deny: [],
    ...patch,
  });

  async function refusals(workspaceId: string) {
    return db
      .select()
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.ownerId, workspaceId),
          eq(authzDecisions.reasonCode, "caller_limited"),
        ),
      );
  }

  async function sessionRow(id: string) {
    const [row] = await db
      .select({
        callerLimit: sessions.callerLimit,
        callerLimitDigest: sessions.callerLimitDigest,
      })
      .from(sessions)
      .where(eq(sessions.id, id));
    return row;
  }

  async function turnRow(id: string, sequence = 1) {
    const [row] = await db
      .select({
        callerChannel: turns.callerChannel,
        callerLimitDigest: turns.callerLimitDigest,
      })
      .from(turns)
      .where(and(eq(turns.sessionId, id), eq(turns.sequence, sequence)));
    return row;
  }

  describe("create", () => {
    test("a repository outside a team rule is refused and logged; inside it the limit is pinned", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws);
      const repoA = await repository();
      const repoB = await repository();
      const teamId = await team(owner, [member]);
      await setRules(owner, agentId, [
        rule(
          { kind: "team", id: teamId },
          { repositories: [repoA.id], tools_deny: ["Bash"] },
        ),
      ]);

      const refused = await create(member, releaseId, { repository: repoB });
      expect(refused).toEqual({
        outcome: "caller_limited",
        dimension: "repository",
      });
      expect(await refusals(ws)).toHaveLength(1);
      expect(
        await db.select().from(sessions).where(eq(sessions.ownerId, ws)),
      ).toHaveLength(0);

      const made = await create(member, releaseId, { repository: repoA });
      expect(made.outcome).toBe("accepted");
      if (made.outcome !== "accepted") return;
      const id = made.response.session_id;
      const row = await sessionRow(id);
      expect(row?.callerLimit).toMatchObject({
        v: 1,
        tools_deny: ["Bash"],
        repositories: [repoA.id],
        mcp_servers: null,
        credentials_deny: [],
      });
      expect(row?.callerLimitDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect((await turnRow(id))?.callerLimitDigest).toBe(
        row?.callerLimitDigest ?? "",
      );
      const outside = await person(ws);
      expect(
        (await create(outside, releaseId, { repository: repoB })).outcome,
      ).toBe("accepted");
    });

    test("a credential the card needs and the caller's limit denies is refused", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws, {
        credentialRefs: ["slack"],
      });
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { credentials_deny: ["slack"] }),
      ]);
      expect(await create(member, releaseId)).toEqual({
        outcome: "caller_limited",
        dimension: "credential",
      });
    });

    test("a tool the release loads and the caller's limit denies is refused and logged; one the release lacks is not", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws, {
        tools: ["Bash", "Read"],
      });
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { tools_deny: ["Write"] }),
      ]);
      expect((await create(member, releaseId)).outcome).toBe("accepted");
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { tools_deny: ["Bash"] }),
      ]);
      expect(await create(member, releaseId)).toEqual({
        outcome: "caller_limited",
        dimension: "tool",
      });
      expect(await refusals(ws)).toHaveLength(1);
    });

    test("an MCP server outside the caller's limit is refused", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws);
      await db.insert(agentMcpSettings).values({
        agentId,
        workspaceId: ws,
        server: "github",
        allowedTools: [],
        credentialRefs: [],
      });
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { mcp_servers: ["jira"] }),
      ]);
      expect(await create(member, releaseId)).toEqual({
        outcome: "caller_limited",
        dimension: "mcp_server",
      });
    });

    test("a repository the catalog lost is no allowance", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws);
      const repo = await repository();
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { repositories: [repo.id] }),
      ]);
      await db
        .update(catalogRepositories)
        .set({ removedAt: new Date() })
        .where(eq(catalogRepositories.id, repo.id));
      expect(await create(member, releaseId, { repository: repo })).toEqual({
        outcome: "caller_limited",
        dimension: "repository",
      });
    });

    test("the store's answer wins when a rule appears after the service looked", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws);
      const repo = await repository();
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { repositories: [] }),
      ]);
      expect(await create(member, releaseId, { repository: repo })).toEqual({
        outcome: "caller_limited",
        dimension: "repository",
      });
      expect(await refusals(ws)).toHaveLength(1);
    });

    test("a start the service refused still replays an earlier acceptance of its key", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws);
      const key = randomUUID();
      const first = await create(member, releaseId, { idempotencyKey: key });
      expect(first.outcome).toBe("accepted");
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { repositories: [] }),
      ]);
      const again = await create(member, releaseId, {
        idempotencyKey: key,
        callerLimited: "repository",
      });
      expect(again.outcome).toBe("replayed");
      expect(
        await create(member, releaseId, { callerLimited: "repository" }),
      ).toEqual({ outcome: "caller_limited", dimension: "repository" });
    });
  });

  describe("input", () => {
    test("a session from before the switch takes a sender with no limit", async () => {
      const ws = await workspace();
      const member = await person(ws);
      const { releaseId } = await agentRelease(ws, { tools: ["Bash"] });
      const id = await session(member, releaseId);
      await db
        .update(sessions)
        .set({ runtimeToolsSource: "profile" })
        .where(eq(sessions.id, id));
      expect(
        (await append(member, id, { profileTools: ["Bash"] })).outcome,
      ).toBe("accepted");
      const turn = await turnRow(id, 2);
      expect(turn?.callerLimitDigest).toBeNull();
    });

    test("a rule denying a tool the session loads refuses; one denying a tool it lacks does not", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws, {
        tools: ["Bash", "Read"],
      });
      const id = await session(member, releaseId);

      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { tools_deny: ["Write"] }),
      ]);
      const ok = await append(member, id);
      expect(ok.outcome).toBe("accepted");
      expect((await turnRow(id, 2))?.callerLimitDigest).toMatch(/^sha256:/);

      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { tools_deny: ["Bash"] }),
      ]);
      expect(await append(member, id)).toEqual({
        outcome: "caller_limited",
        dimension: "tool",
      });
      expect(await refusals(ws)).toHaveLength(1);
    });

    test("the base tool list of a profile-sourced session is the profile's, narrowed by the release snapshot", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws, {
        snapshotTools: ["Read"],
      });
      const id = await session(member, releaseId);
      await db
        .update(sessions)
        .set({ runtimeToolsSource: "profile" })
        .where(eq(sessions.id, id));
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { tools_deny: ["Bash"] }),
      ]);
      expect(
        (await append(member, id, { profileTools: ["Bash", "Read"] })).outcome,
      ).toBe("accepted");
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { tools_deny: ["Read"] }),
      ]);
      expect(
        await append(member, id, { profileTools: ["Bash", "Read"] }),
      ).toEqual({ outcome: "caller_limited", dimension: "tool" });
    });

    test("a tool the creator's own limit already took away is not asked of them again", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws);
      const id = await session(member, releaseId);
      // A profile-sourced session keeps its tools open to the profile; the
      // pinned limit already took Bash away from it.
      await db
        .update(sessions)
        .set({
          runtimeToolsSource: "profile",
          callerLimit: {
            v: 1,
            tools_deny: ["Bash"],
            repositories: null,
            mcp_servers: null,
            credentials_deny: [],
            revision: 1,
          },
        })
        .where(eq(sessions.id, id));
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { tools_deny: ["Bash"] }),
      ]);
      expect(
        (await append(member, id, { profileTools: ["Bash"] })).outcome,
      ).toBe("accepted");
      const channelSender = await person(ws, "owner");
      expect(
        (await append(channelSender, id, { profileTools: ["Bash"] })).outcome,
      ).toBe("accepted");
    });

    test("a narrower sender cannot move a session made wider; the session's repository and MCP server count", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const creator = await person(ws, "owner");
      const narrow = await person(ws);
      const repo = await repository();
      const { agentId, releaseId } = await agentRelease(ws);
      await db.insert(agentMcpSettings).values({
        agentId,
        workspaceId: ws,
        server: "github",
        allowedTools: [],
        credentialRefs: [],
      });
      const id = await session(creator, releaseId, repo);
      const narrowTeam = await team(owner, [narrow]);
      await setRules(owner, agentId, [
        rule({ kind: "team", id: narrowTeam }, { repositories: [] }),
      ]);
      expect(await append(narrow, id)).toEqual({
        outcome: "caller_limited",
        dimension: "repository",
      });
      await setRules(owner, agentId, [
        rule({ kind: "team", id: narrowTeam }, { mcp_servers: [] }),
      ]);
      expect(await append(narrow, id)).toEqual({
        outcome: "caller_limited",
        dimension: "mcp_server",
      });
      expect((await append(creator, id)).outcome).toBe("accepted");
    });
  });

  describe("what a session really reaches", () => {
    const features = {
      workflows: false,
      actions: false,
      checks: false,
      issues: false,
      review: false,
    };

    test("a tool the agent's MCP settings add counts, on create and on a profile-sourced input", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws);
      await db.insert(agentMcpSettings).values({
        agentId,
        workspaceId: ws,
        server: "jira",
        allowedTools: ["mcp__jira__search"],
        credentialRefs: [],
      });
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { tools_deny: ["mcp__jira__other"] }),
      ]);
      const id = await session(member, releaseId);

      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { tools_deny: ["mcp__jira__search"] }),
      ]);
      expect(await create(member, releaseId)).toEqual({
        outcome: "caller_limited",
        dimension: "tool",
      });
      await db
        .update(sessions)
        .set({ runtimeToolsSource: "profile" })
        .where(eq(sessions.id, id));
      expect(await append(member, id, { profileTools: [] })).toEqual({
        outcome: "caller_limited",
        dimension: "tool",
      });
    });

    test("the built-in github server and its tools count", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws);
      const githubTool = githubMcpToolNames(GITHUB_MCP_FIXED_TOOLS)[0] ?? "";
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { mcp_servers: [] }),
      ]);
      expect(
        (await create(member, releaseId, { githubPolicySource: "agent" }))
          .outcome,
      ).toBe("caller_limited");
      await setRules(owner, agentId, [
        rule({ kind: "workspace" }, { tools_deny: [githubTool] }),
      ]);
      expect(
        await create(member, releaseId, { githubPolicySource: "agent" }),
      ).toEqual({ outcome: "caller_limited", dimension: "tool" });
    });

    test("a session with no attached list may attach any repository its policy lists", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const creator = await person(ws, "owner");
      const narrow = await person(ws);
      const repoA = await repository();
      const repoB = await repository();
      const { agentId, releaseId } = await agentRelease(ws);
      await db.insert(agentGitHubSettings).values({
        agentId,
        workspaceId: ws,
        repositories: [repoA.id, repoB.id],
        pushApproval: false,
        features,
        actionsAllow: [],
      });
      const made = await create(creator, releaseId, {
        githubPolicySource: "agent",
      });
      if (made.outcome !== "accepted") throw new Error(made.outcome);
      const id = made.response.session_id;
      const narrowTeam = await team(owner, [narrow]);

      await setRules(owner, agentId, [
        rule({ kind: "team", id: narrowTeam }, { repositories: [repoA.id] }),
      ]);
      expect(await append(narrow, id)).toEqual({
        outcome: "caller_limited",
        dimension: "repository",
      });
      await setRules(owner, agentId, [
        rule(
          { kind: "team", id: narrowTeam },
          { repositories: [repoA.id, repoB.id] },
        ),
      ]);
      expect((await append(narrow, id)).outcome).toBe("accepted");
    });
  });

  describe("usable agents", () => {
    test("an agent whose active release needs a denied credential is left out; a repository limit never hides one", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const member = await person(ws);
      const a = await agentRelease(ws, { credentialRefs: ["slack"] });
      const b = await agentRelease(ws, { credentialRefs: ["jira"] });
      const c = await agentRelease(ws);
      const memberTeam = await team(owner, [member]);
      await setRules(owner, a.agentId, [
        rule({ kind: "team", id: memberTeam }, { credentials_deny: ["slack"] }),
      ]);
      await setRules(owner, c.agentId, [
        rule({ kind: "workspace" }, { repositories: [] }),
      ]);
      const store = createPostgresAgentStore(db);
      const listed = async (who: Caller) =>
        (
          await store.listUsable(
            ws,
            { userId: idOf(who), keyAgentId: null, outsideUse: true },
            50,
          )
        ).map((agent) => agent.id);
      const seen = await listed(member);
      expect(seen).not.toContain(a.agentId);
      expect(seen).toContain(b.agentId);
      expect(seen).toContain(c.agentId);
      expect(await listed(owner)).toContain(a.agentId);
    });
  });

  describe("concurrency", () => {
    test("create, input, a rule edit, a team archive and a member removal settle without a deadlock", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const members = await Promise.all(
        Array.from({ length: 6 }, () => person(ws)),
      );
      const { agentId, releaseId } = await agentRelease(ws, {
        tools: ["Bash"],
      });
      const repo = await repository();
      const teamId = await team(owner, members);
      const spare = await team(owner, members.slice(0, 3));
      await setRules(owner, agentId, [
        rule({ kind: "team", id: teamId }, { repositories: [repo.id] }),
        rule({ kind: "team", id: spare }, { tools_deny: ["Write"] }),
      ]);
      const existing = await Promise.all(
        members.map((who) => session(who, releaseId, repo)),
      );

      for (let round = 0; round < 3; round++) {
        const results = await Promise.race([
          Promise.allSettled([
            ...members.map((who) =>
              create(who, releaseId, { repository: repo }),
            ),
            ...members.map((who, i) => append(who, existing[i] as string)),
            setRules(owner, agentId, [
              rule(
                { kind: "team", id: teamId },
                { repositories: [repo.id], tools_deny: [`t${round}`] },
              ),
              ...(round < 2
                ? [rule({ kind: "team", id: spare }, { tools_deny: ["Write"] })]
                : []),
            ]),
            round === 1
              ? teams().delete({
                  actor: acting(owner),
                  receiptId: randomUUID(),
                  teamId: spare,
                })
              : Promise.resolve(),
            teams().removeMember({
              actor: acting(owner),
              receiptId: randomUUID(),
              teamId,
              userId: idOf(members[round] as Caller),
            }),
          ]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out: deadlock?")), 45_000),
          ),
        ]);
        for (const settled of results) {
          if (settled.status === "rejected") {
            expect(String(settled.reason)).not.toMatch(/deadlock|40P01/i);
          }
        }
      }
    }, 150_000);
  });
});
