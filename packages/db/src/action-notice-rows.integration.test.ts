import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReceiptActor, UserLocale } from "@werft-ai/contracts";
import type {
  PullRequestDrainStore,
  PushRequestStore,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPullRequestDrain } from "./pull-request-drain.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import {
  agents,
  pushRequests,
  sessionLinks,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-notice";
const COMMIT = "c".repeat(40);
const HUMAN: ReceiptActor = {
  principal: { kind: "api_key", id: "key-approver" },
  actor_user_id: null,
  agent_id: null,
};

const OPENED: Record<UserLocale, string> = {
  ko: "PR #7을 열었어요: app",
  ja: "PR #7 を作成しました: app",
  en: "Opened PR #7 in app",
};

/**
 * The `action_notice` rows a push and its pull request leave in the Slack
 * outbox, read from a real database: one row per result, written in the
 * transaction of the state change, in the language of whoever started the
 * session.
 */
integration("action_notice rows on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pushes: PushRequestStore;
  let drain: PullRequestDrainStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "action_notice_rows" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    pushes = createPostgresPushRequests(db);
    drain = createPostgresPullRequestDrain(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  /**
   * A session with a live primary Slack thread whose starter has `locale`.
   * The agent, release and surface rows the link points at are not what is
   * under test, so the seeding connection skips foreign keys.
   */
  async function threadedSession(locale: UserLocale) {
    const sessionId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const appRowId = crypto.randomUUID();
    const installationId = crypto.randomUUID();
    const appId = `A${appRowId.slice(0, 8).toUpperCase()}`;
    const agentId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: locale,
      locale,
    });
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
      createdBy: userId,
    });
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: OWNER,
      repoUrl: "https://github.com/acme/app.git",
      branch: "main",
      repositoryId: "app",
      checkpointRevision: 1,
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
      botTokenRef: `slack_app:${appRowId}/slack_bot_token`,
      eventsState: "verified",
      eventsUrl: "https://example.invalid/slack/events",
    });
    await db.insert(slackInstallations).values({
      id: installationId,
      workspaceId,
      appId,
      teamId: "T1",
    });
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await drizzle(client, { schema }).insert(sessionLinks).values({
        id: crypto.randomUUID(),
        workspaceId,
        ownerId: OWNER,
        sessionId,
        installationId,
        surfaceBindingId: crypto.randomUUID(),
        surfaceRef: "C1",
        channelId: "C1",
        threadId: "1730000000.000100",
        openedByTs: "1730000000.000100",
        agentId,
        releaseId: "rel-1",
        profileId: "profile-1",
        createdBy: userId,
      });
    } finally {
      await client.query("RESET session_replication_role");
      client.release();
    }
    return sessionId;
  }

  /** A push request that carries a pull request intent, pushed by `finish`. */
  async function pushedWithIntent(
    sessionId: string,
    repositoryId = "app",
    commit = COMMIT,
  ) {
    const created = await pushes.create({
      ownerId: OWNER,
      sessionId,
      actor: HUMAN,
      idempotencyKey: `k-${crypto.randomUUID()}`,
      payloadHash: "h",
      repositoryId,
      repositoryBinding: "sha256:binding",
      checkpointRevision: 1,
      gitCommit: commit,
      policyApproval: null,
      policyFields: {},
    });
    if (created.outcome !== "written") throw new Error("not written");
    const id = created.request.id;
    await db
      .update(pushRequests)
      .set({ flow: "actions", pullRequestIntent: { title: "Add the thing" } })
      .where(eq(pushRequests.id, id));
    await pushes.decide({
      ownerId: OWNER,
      sessionId,
      pushRequestId: id,
      actor: HUMAN,
      decision: "approve",
      gitCommit: commit,
      reason: null,
      idempotencyKey: `d-${id}`,
      payloadHash: "h",
    });
    const job = await pushes.claimNextApproved(60_000);
    if (job?.id !== id) throw new Error("claimed another request");
    await pushes.finish(job, {
      state: "pushed",
      remoteUrl: "https://github.com/acme/app.git",
      remoteRef: `refs/heads/agent/${sessionId}`,
      previousCommit: null,
    });
    return id;
  }

  const notices = (sessionId: string) =>
    db
      .select()
      .from(slackOutbox)
      .where(eq(slackOutbox.sessionId, sessionId))
      .orderBy(asc(slackOutbox.dedupeKey));

  for (const locale of ["ko", "ja", "en"] as const) {
    test(`${locale}: the push finishing leaves a due stage and its notice together; opening leaves one more`, async () => {
      const sessionId = await threadedSession(locale);
      const id = await pushedWithIntent(sessionId);

      const stage = (
        await db.select().from(pushRequests).where(eq(pushRequests.id, id))
      )[0];
      expect(stage).toMatchObject({ state: "pushed", prState: "due" });
      expect((await notices(sessionId)).map((n) => n.dedupeKey)).toEqual([
        `action:${id}:pushed`,
      ]);

      const job = await drain.claimNextDue(60_000);
      if (job?.id !== id) throw new Error("claimed another request");
      await drain.settle(job, {
        kind: "opened",
        pullRequest: {
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          head: `agent/${sessionId}`,
          base: "main",
          headSha: COMMIT,
          title: "Add the thing",
          created: true,
        },
      });

      const rows = await notices(sessionId);
      expect(rows.map((n) => n.dedupeKey)).toEqual([
        `action:${id}:opened`,
        `action:${id}:pushed`,
      ]);
      const opened = rows[0];
      expect(opened).toMatchObject({
        kind: "action_notice",
        channelId: "C1",
        threadTs: "1730000000.000100",
      });
      expect(opened?.body).toMatchObject({
        text: OPENED[locale],
        link_url: "https://github.com/acme/app/pull/7",
        locale,
      });
    });
  }

  for (const [locale, text] of [
    ["ko", "열려 있던 PR #7에 새 push(ddddddd)를 반영했어요: app"],
    ["en", "Updated the open PR #7 in app with the new push (ddddddd)"],
  ] as const) {
    test(`${locale}: a later push whose branch already has the pull request says it updated it, not opened it`, async () => {
      const sessionId = await threadedSession(locale);
      const open = async (id: string, commit: string, created: boolean) => {
        const job = await drain.claimNextDue(60_000);
        if (job?.id !== id) throw new Error("claimed another request");
        await drain.settle(job, {
          kind: "opened",
          pullRequest: {
            number: 7,
            url: "https://github.com/acme/app/pull/7",
            head: `agent/${sessionId}`,
            base: "main",
            headSha: commit,
            title: "Add the thing",
            created,
          },
        });
      };
      const first = await pushedWithIntent(sessionId);
      await open(first, COMMIT, true);
      const second = await pushedWithIntent(sessionId, "app", "d".repeat(40));
      // GitHub answers with the pull request the branch already has.
      await open(second, "d".repeat(40), false);

      const rows = await notices(sessionId);
      expect(rows.map((n) => n.dedupeKey).sort()).toEqual(
        [
          `action:${first}:opened`,
          `action:${first}:pushed`,
          `action:${second}:pr_updated`,
          `action:${second}:pushed`,
        ].sort(),
      );
      const updated = rows.find(
        (n) => n.dedupeKey === `action:${second}:pr_updated`,
      );
      expect(updated?.body).toMatchObject({
        text,
        link_url: "https://github.com/acme/app/pull/7",
      });
    });
  }

  test("a thread that never heard the pull request opened hears it opened, not updated", async () => {
    const sessionId = await threadedSession("en");
    const [before] = await db
      .select({ status: slackInstallations.status })
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, "T1"));
    const installations = () =>
      db
        .update(slackInstallations)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(slackInstallations.teamId, "T1"));
    const open = async (id: string, commit: string, created: boolean) => {
      const job = await drain.claimNextDue(60_000);
      if (job?.id !== id) throw new Error("claimed another request");
      await drain.settle(job, {
        kind: "opened",
        pullRequest: {
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          head: `agent/${sessionId}`,
          base: "main",
          headSha: commit,
          title: "Add the thing",
          created,
        },
      });
    };
    // The installation is revoked while the first push opens the PR.
    await installations();
    const first = await pushedWithIntent(sessionId);
    await open(first, COMMIT, true);
    expect(await notices(sessionId)).toEqual([]);
    // Installed again: the same row is live once more.
    await db
      .update(slackInstallations)
      .set({ status: before?.status ?? "pending", revokedAt: null })
      .where(eq(slackInstallations.teamId, "T1"));
    const second = await pushedWithIntent(sessionId, "app", "d".repeat(40));
    await open(second, "d".repeat(40), false);
    expect((await notices(sessionId)).map((n) => n.dedupeKey).sort()).toEqual(
      [`action:${second}:opened`, `action:${second}:pushed`].sort(),
    );
  });

  test("an opening notice that was given up on does not count as told", async () => {
    const sessionId = await threadedSession("en");
    const open = async (id: string, commit: string, created: boolean) => {
      const job = await drain.claimNextDue(60_000);
      if (job?.id !== id) throw new Error("claimed another request");
      await drain.settle(job, {
        kind: "opened",
        pullRequest: {
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          head: `agent/${sessionId}`,
          base: "main",
          headSha: commit,
          title: "Add the thing",
          created,
        },
      });
    };
    const first = await pushedWithIntent(sessionId);
    await open(first, COMMIT, true);
    // The outbox closed it unsent (the installation went away meanwhile).
    await db
      .update(slackOutbox)
      .set({ status: "failed", errorCode: "not_addressed" })
      .where(eq(slackOutbox.dedupeKey, `action:${first}:opened`));
    const second = await pushedWithIntent(sessionId, "app", "d".repeat(40));
    await open(second, "d".repeat(40), false);
    const keys = (await notices(sessionId)).map((n) => n.dedupeKey);
    expect(keys).toContain(`action:${second}:opened`);
    expect(keys).not.toContain(`action:${second}:pr_updated`);
  });

  test("the list shows the stage, why it ended and the recorded pull request", async () => {
    const sessionId = await threadedSession("en");
    const id = await pushedWithIntent(sessionId);
    const listed = async () => {
      const items = await pushes.list(OWNER, sessionId);
      const found = items?.find((item) => item.id === id);
      if (!found) throw new Error("not listed");
      return found;
    };
    expect(await listed()).toMatchObject({
      pr_state: "due",
      pr_error: null,
      pr_number: null,
      pr_url: null,
    });

    const job = await drain.claimNextDue(60_000);
    if (job?.id !== id) throw new Error("claimed another request");
    await drain.settle(job, {
      kind: "opened",
      pullRequest: {
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        head: `agent/${sessionId}`,
        base: "main",
        headSha: COMMIT,
        title: "Add the thing",
        created: true,
      },
    });
    expect(await listed()).toMatchObject({
      pr_state: "opened",
      pr_error: null,
      pr_number: 7,
      pr_url: "https://github.com/acme/app/pull/7",
    });
    expect(await pushes.get(OWNER, sessionId, id)).toMatchObject({
      pr_number: 7,
    });

    const failed = await pushedWithIntent(await threadedSession("en"));
    const next = await drain.claimNextDue(60_000);
    if (next?.id !== failed) throw new Error("claimed another request");
    await drain.settle(next, {
      kind: "stop",
      stage: "failed",
      error: "head_moved",
    });
    const [failedRow] = await db
      .select({ sessionId: pushRequests.sessionId })
      .from(pushRequests)
      .where(eq(pushRequests.id, failed));
    const items = await pushes.list(OWNER, failedRow?.sessionId ?? "");
    expect(items?.[0]).toMatchObject({
      pr_state: "failed",
      pr_error: "head_moved",
      pr_number: null,
      pr_url: null,
    });
  });

  test("a later push that finds the pull request already open lists the same number and link", async () => {
    const sessionId = await threadedSession("en");
    const pullRequest = {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      head: `agent/${sessionId}`,
      base: "main",
      headSha: COMMIT,
      title: "Add the thing",
    };
    const first = await pushedWithIntent(sessionId);
    const firstJob = await drain.claimNextDue(60_000);
    if (firstJob?.id !== first) throw new Error("claimed another request");
    await drain.settle(firstJob, {
      kind: "opened",
      pullRequest: { ...pullRequest, created: true },
    });

    const second = await pushedWithIntent(sessionId);
    const secondJob = await drain.claimNextDue(60_000);
    if (secondJob?.id !== second) throw new Error("claimed another request");
    await drain.settle(secondJob, {
      kind: "opened",
      pullRequest: { ...pullRequest, created: false },
    });

    const items = await pushes.list(OWNER, sessionId);
    for (const id of [first, second]) {
      expect(items?.find((item) => item.id === id)).toMatchObject({
        pr_state: "opened",
        pr_number: 7,
        pr_url: pullRequest.url,
      });
    }
  });

  test("a reused pull request is found in its own repository, not in another with the same number", async () => {
    const sessionId = await threadedSession("en");
    const open = async (repositoryId: string, created: boolean) => {
      const id = await pushedWithIntent(sessionId, repositoryId);
      const job = await drain.claimNextDue(60_000);
      if (job?.id !== id) throw new Error("claimed another request");
      await drain.settle(job, {
        kind: "opened",
        pullRequest: {
          number: 7,
          url: `https://github.com/acme/${repositoryId}/pull/7`,
          head: `agent/${sessionId}`,
          base: "main",
          headSha: COMMIT,
          title: "Add the thing",
          created,
        },
      });
      return id;
    };
    await open("app", true);
    await open("docs", true);
    const later = await open("docs", false);

    const items = await pushes.list(OWNER, sessionId);
    expect(items?.find((item) => item.id === later)).toMatchObject({
      pr_number: 7,
      pr_url: "https://github.com/acme/docs/pull/7",
    });
    expect(await pushes.get(OWNER, sessionId, later)).toMatchObject({
      pr_url: "https://github.com/acme/docs/pull/7",
    });
  });

  test("an uncertain stage tells the thread once, and a settle that lost its claim adds nothing", async () => {
    const sessionId = await threadedSession("en");
    const id = await pushedWithIntent(sessionId);
    const job = await drain.claimNextDue(60_000);
    if (job?.id !== id) throw new Error("claimed another request");
    const stop = {
      kind: "stop",
      stage: "uncertain",
      error: "lookup_failed",
    } as const;
    expect(await drain.settle(job, stop)).toEqual({ result: "settled" });
    expect(await drain.settle(job, stop)).toEqual({ result: "fenced" });

    const uncertain = (await notices(sessionId)).filter(
      (n) => n.dedupeKey === `action:${id}:pr_uncertain`,
    );
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0]?.body).toMatchObject({
      text: "Could not confirm whether a PR was opened (lookup_failed). Check app agent/".concat(
        `${sessionId} on GitHub.`,
      ),
    });
  });
});
