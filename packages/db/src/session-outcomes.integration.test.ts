import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  listSessionOutcomesResponseSchema,
  type ReceiptActor,
} from "@werft-ai/contracts";
import {
  createOutcomeRefresher,
  ForgeCredentialError,
  type ForgePullRequestDetail,
  GitHubCallError,
  type GitHubConnection,
  type GitHubGrant,
  type GitHubRateLimit,
  type SessionCatalog,
  type SessionOutcomeStore,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPullRequests } from "./action/pull-requests.ts";
import { createPostgresGitHubGateStore } from "./github-settings.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import {
  outcomeRefreshQuotas,
  pullRequests,
  sessionOutcomes,
  sessions,
} from "./schema.ts";
import { createPostgresSessionOutcomes } from "./sessions/session-outcomes.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-outcomes";
const HUMAN: ReceiptActor = {
  principal: { kind: "api_key", id: "key-outcomes" },
  actor_user_id: null,
  agent_id: null,
};
const NO_LIMIT: GitHubRateLimit = {
  limit: null,
  remaining: null,
  reset: null,
  retryAfterSeconds: null,
};

type PullState = "open" | "closed" | "merged";

function answer(number: number, state: PullState) {
  const at = "2026-10-31T00:00:00.000Z";
  const pullRequest: ForgePullRequestDetail = {
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    state: state === "open" ? "open" : "closed",
    head: "agent/x",
    headSha: "a".repeat(40),
    base: "main",
    title: `${"t".repeat(200)}-${number}`,
    body: "",
    mergedAt: state === "merged" ? at : null,
    closedAt: state === "open" ? null : at,
    mergeCommitSha: state === "merged" ? "d".repeat(40) : null,
    additions: 2,
    deletions: 1,
    changedFiles: 1,
    commits: 1,
  };
  return pullRequest;
}

type Read = (number: number) => Promise<{
  pullRequest: ForgePullRequestDetail;
  rateLimit: GitHubRateLimit;
}>;

integration("postgres session outcomes and the outcome refresher", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: SessionOutcomeStore;
  const catalog: SessionCatalog = { connections: {}, repositories: {} };

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_outcomes_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    store = createPostgresSessionOutcomes(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  /** A repository of the test's own, so other tests' rows stay out of it. */
  function repository(): string {
    const id = `repo-${randomUUID().slice(0, 8)}`;
    catalog.repositories[id] = {
      url: `https://github.com/acme/${id}.git`,
      branch: "main",
    } as SessionCatalog["repositories"][string];
    return id;
  }

  async function session(repositoryId: string): Promise<string> {
    const id = randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: OWNER,
      repoUrl: `https://github.com/acme/${repositoryId}.git`,
      branch: "main",
      repositoryId,
      checkpointRevision: 1,
    });
    repositoryOf.set(id, repositoryId);
    return id;
  }
  const repositoryOf = new Map<string, string>();

  let nextNumber = 100;
  async function outcome(
    repositoryId: string,
    fields: Partial<typeof sessionOutcomes.$inferInsert> = {},
  ) {
    const sessionId = fields.sessionId ?? (await session(repositoryId));
    nextNumber += 1;
    const [row] = await db
      .insert(sessionOutcomes)
      .values({
        id: randomUUID(),
        ownerId: OWNER,
        sessionId,
        type: "github_pull_request",
        url: `https://github.com/acme/${repositoryId}/pull/${nextNumber}`,
        repositoryId,
        externalId: String(nextNumber),
        state: "open",
        stateChangedAt: new Date(),
        metadata: { head: "agent/x", base: "main", adopted: false },
        ...fields,
      })
      .returning();
    if (!row) throw new Error("no outcome row");
    return row;
  }

  async function rowOf(id: string) {
    const [row] = await db
      .select()
      .from(sessionOutcomes)
      .where(eq(sessionOutcomes.id, id));
    if (!row) throw new Error(`no outcome ${id}`);
    return row;
  }

  async function quotaOf(quotaKey: string) {
    const [row] = await db
      .select()
      .from(outcomeRefreshQuotas)
      .where(eq(outcomeRefreshQuotas.quotaKey, quotaKey));
    return row;
  }

  /** Makes rows due again as if `minutes` had passed since their last read. */
  async function age(ids: string[], minutes: number) {
    await db
      .update(sessionOutcomes)
      .set({
        stateCheckedAt: sql`now() - make_interval(mins => ${minutes})`,
      })
      .where(inArray(sessionOutcomes.id, ids));
  }

  /**
   * One API replica's refresher over `repositories` only. GitHub is `read`;
   * every repository spends from `unitOf(repository)`.
   */
  function replica(input: {
    repositories: string[];
    unitOf: (repositoryId: string) => Promise<string>;
    read: Read;
    grant?: () => Promise<GitHubGrant | null>;
    claimMax?: number;
    leaseMs?: number;
    /** An App connection whose own JWT tells this. */
    installed?: () => Promise<boolean>;
    /** In the catalog with no App or PAT serving them. */
    unconnected?: string[];
  }) {
    const calls: number[] = [];
    const warnings: Array<{ message: string; fields?: unknown }> = [];
    const api = {
      getPullRequest: (number: number) => {
        calls.push(number);
        return input.read(number);
      },
    };
    // Only this replica's repositories: the other tests' rows stay out of it.
    const own = [...input.repositories, ...(input.unconnected ?? [])];
    const refresher = createOutcomeRefresher({
      store,
      catalog: {
        ...catalog,
        repositories: Object.fromEntries(
          Object.entries(catalog.repositories).filter(([id]) =>
            own.includes(id),
          ),
        ),
      },
      gate: {
        // The grant's connection is the one the replica's own stub serves.
        grant:
          input.grant ??
          (async ({ sessionId }) =>
            ({
              api,
              unit: () => input.unitOf(repositoryOf.get(sessionId) ?? ""),
            }) as unknown as GitHubGrant),
      },
      connections: (repositoryId) =>
        input.repositories.includes(repositoryId)
          ? {
              kind: "fixed",
              connection: {
                kind: input.installed ? "app" : "pat",
                quotaKey: () => input.unitOf(repositoryId),
                installed: input.installed ?? (async () => null),
              } as unknown as GitHubConnection,
            }
          : null,
      logger: {
        info() {},
        warn: (message, fields) => warnings.push({ message, fields }),
      },
      ...(input.claimMax === undefined ? {} : { claimMax: input.claimMax }),
      ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
    });
    return { refresher, calls, warnings };
  }

  const states =
    (map: Map<number, PullState>): Read =>
    async (number) => ({
      pullRequest: answer(number, map.get(number) ?? "open"),
      rateLimit: NO_LIMIT,
    });

  /** A GitHub that answers only when `release` is called. */
  function slowGitHub(state: PullState) {
    let release: () => void = () => {};
    let asked: () => void = () => {};
    const askedOnce = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const read: Read = (number) => {
      asked();
      return new Promise((resolve) => {
        release = () =>
          resolve({ pullRequest: answer(number, state), rateLimit: NO_LIMIT });
      });
    };
    return { read, askedOnce, release: () => release() };
  }

  test("a pull_requests row without an outcome gets one from its own receipt; an older row without a push request does not", async () => {
    const pushes = createPostgresPushRequests(db);
    const pulls = createPostgresPullRequests(db);
    const repo = repository();
    const sessionId = await session(repo);
    const created = await pushes.create({
      ownerId: OWNER,
      sessionId,
      actor: HUMAN,
      idempotencyKey: `k-${randomUUID()}`,
      payloadHash: "h",
      repositoryId: repo,
      repositoryBinding: "sha256:binding",
      checkpointRevision: 1,
      gitCommit: "c".repeat(40),
      policyApproval: null,
      policyFields: {},
    });
    if (created.outcome !== "written") throw new Error("no push request");
    const url = `https://github.com/acme/${repo}/pull/5`;
    const saved = await pulls.savePullRequest({
      ownerId: OWNER,
      sessionId,
      pushRequestId: created.request.id,
      actor: HUMAN,
      repositoryId: repo,
      number: 5,
      url,
      title: "Retry failed payments",
      head: `agent/${sessionId}`,
      base: "main",
      created: true,
    });
    // As an earlier image left it: the pull request, no outcome.
    await db
      .delete(sessionOutcomes)
      .where(eq(sessionOutcomes.sessionId, sessionId));
    await db
      .update(pullRequests)
      .set({ createdAt: sql`now() - interval '3 days'` })
      .where(eq(pullRequests.url, url));
    const older = await session(repo);
    await db.insert(pullRequests).values({
      sessionId: older,
      url: `https://github.com/acme/${repo}/pull/4`,
    });

    const unit = `app:test:${randomUUID()}`;
    const { refresher, calls } = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: states(new Map()),
    });
    await refresher.runOnce();

    const filled = await db
      .select()
      .from(sessionOutcomes)
      .where(eq(sessionOutcomes.repositoryId, repo));
    expect(filled).toHaveLength(1);
    const [pull] = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.url, url));
    expect(filled[0]).toMatchObject({
      sessionId,
      url,
      externalId: "5",
      state: "open",
      receiptId: saved.receiptId,
      createdAt: pull?.createdAt,
      metadata: expect.objectContaining({
        adopted: null,
        head: `agent/${sessionId}`,
      }),
    });
    // Its state_checked_at was null, so the same pass read it.
    expect(calls).toEqual([5]);
    expect(filled[0]?.stateCheckedAt).not.toBeNull();
  });

  test("two replicas never take one row, and neither holds a database lock while GitHub answers", async () => {
    const repo = repository();
    const unit = `app:test:${randomUUID()}`;
    const [a, b] = [await outcome(repo), await outcome(repo)];
    const slow = slowGitHub("merged");
    const first = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: slow.read,
      claimMax: 1,
    });
    const second = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: states(new Map()),
      claimMax: 1,
    });
    const running = first.refresher.runOnce();
    await slow.askedOnce;
    // The other replica claims, reads and writes while the first waits.
    await second.refresher.runOnce();
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]).not.toBe(first.calls[0]);
    slow.release();
    await running;
    const rows = [await rowOf(a.id), await rowOf(b.id)];
    expect(rows.map((row) => row.stateCheckedAt === null)).toEqual([
      false,
      false,
    ]);
    expect(rows.map((row) => row.leaseToken)).toEqual([null, null]);
    expect((await quotaOf(unit))?.used).toBe(2);
  });

  test("a claimed row no answer came for keeps its state_checked_at; a late open never overwrites the newer merged", async () => {
    const repo = repository();
    const unit = `app:test:${randomUUID()}`;
    const row = await outcome(repo);
    const slow = slowGitHub("open");
    const late = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: slow.read,
      leaseMs: 200,
    });
    const running = late.refresher.runOnce();
    await slow.askedOnce;
    const claimed = await rowOf(row.id);
    expect(claimed.leaseToken).not.toBeNull();
    expect(claimed.stateCheckedAt).toBeNull();

    await Bun.sleep(400);
    const number = Number(row.externalId);
    const next = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: states(new Map([[number, "merged"]])),
    });
    await next.refresher.runOnce();
    const merged = await rowOf(row.id);
    expect(merged).toMatchObject({ state: "merged", leaseToken: null });

    slow.release();
    await running;
    const after = await rowOf(row.id);
    expect(after.state).toBe("merged");
    expect(after.stateCheckedAt).toEqual(merged.stateCheckedAt);
    expect(after.mergedAt).toEqual(merged.mergedAt);
  });

  test("concurrent claims of one unit never pass its budget: 50 left is 50 claimed", async () => {
    const repo = repository();
    const unit = `app:test:${randomUUID()}`;
    for (let index = 0; index < 120; index += 1) await outcome(repo);
    // Limit 1000 is a budget of 200; 150 of it already spent this window.
    await db
      .insert(outcomeRefreshQuotas)
      .values({ quotaKey: unit, rateLimit: 1000, used: 150 });
    const claims = await Promise.all(
      [0, 1, 2, 3].map(() =>
        store.claim({
          quotaKey: unit,
          repositoryIds: [repo],
          max: 50,
          leaseMs: 60_000,
        }),
      ),
    );
    const ids = claims.flat().map((claimed) => claimed.id);
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
    expect((await quotaOf(unit))?.used).toBe(200);
  });

  test("reading recent pull requests every 5 minutes for an hour spends the budget and stops at it", async () => {
    const repo = repository();
    const unit = `app:test:${randomUUID()}`;
    const rows = [
      await outcome(repo),
      await outcome(repo),
      await outcome(repo),
    ];
    const ids = rows.map((row) => row.id);
    // Limit 50: a budget of 10 an hour.
    await db
      .insert(outcomeRefreshQuotas)
      .values({ quotaKey: unit, rateLimit: 50 });
    const { refresher, calls } = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: states(new Map()),
    });
    const spent: number[] = [];
    for (let pass = 0; pass < 12; pass += 1) {
      await refresher.runOnce();
      spent.push((await quotaOf(unit))?.used ?? -1);
      await age(ids, 6);
    }
    expect(spent).toEqual([3, 6, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    expect(calls).toHaveLength(10);

    // The next window starts the budget over.
    await db
      .update(outcomeRefreshQuotas)
      .set({ windowStart: sql`now() - interval '61 minutes'` })
      .where(eq(outcomeRefreshQuotas.quotaKey, unit));
    await refresher.runOnce();
    expect(calls).toHaveLength(13);
    expect((await quotaOf(unit))?.used).toBe(3);
  });

  test("a 500 is a forge_failed check, not read again in the same pass or before its interval", async () => {
    const repo = repository();
    const row = await outcome(repo);
    const { refresher, calls } = replica({
      repositories: [repo],
      unitOf: async () => `app:test:${repo}`,
      read: async () => {
        throw new GitHubCallError("pull request read", 500, "req-1");
      },
    });
    await refresher.runOnce();
    await refresher.runOnce();
    expect(calls).toHaveLength(1);
    const failed = await rowOf(row.id);
    expect(failed).toMatchObject({
      state: "open",
      checkError: "forge_failed",
      leaseToken: null,
    });
    expect(failed.stateCheckedAt).not.toBeNull();
  });

  test("a repository whose unit cannot be told (GET /user failing) has no row claimed", async () => {
    const repo = repository();
    const row = await outcome(repo);
    const { refresher, calls, warnings } = replica({
      repositories: [repo],
      unitOf: async () => {
        throw new Error("GET /user failed");
      },
      read: states(new Map()),
    });
    await refresher.runOnce();
    expect(calls).toEqual([]);
    expect(await rowOf(row.id)).toMatchObject({
      leaseToken: null,
      stateCheckedAt: null,
    });
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: "Outcome refresh: rate-limit unit unknown",
      }),
    );
  });

  test("a repository no read can reach still gets its check: App uninstalled is not_found, its lookup failing forge_failed, no App or PAT github_refused", async () => {
    const [gone, failing, unconnected] = [
      repository(),
      repository(),
      repository(),
    ];
    const rows = [
      await outcome(gone),
      await outcome(failing),
      await outcome(unconnected),
    ];
    const lookupFails = async () => {
      throw new Error("installation lookup failed");
    };
    const first = replica({
      repositories: [gone],
      unitOf: lookupFails,
      read: states(new Map()),
      installed: async () => false,
      unconnected: [unconnected],
    });
    await first.refresher.runOnce();
    const second = replica({
      repositories: [failing],
      unitOf: lookupFails,
      read: states(new Map()),
      installed: async () => {
        throw new Error("JWT refused");
      },
    });
    await second.refresher.runOnce();
    expect([...first.calls, ...second.calls]).toEqual([]);
    const checked = await Promise.all(rows.map((row) => rowOf(row.id)));
    expect(checked.map((row) => row.checkError)).toEqual([
      "not_found",
      "forge_failed",
      "github_refused",
    ]);
    for (const row of checked) {
      expect(row).toMatchObject({ state: "open", leaseToken: null });
      expect(row.stateCheckedAt).not.toBeNull();
    }

    // Checked now, they wait out their interval like any other check.
    await first.refresher.runOnce();
    expect((await rowOf(rows[0]?.id ?? "")).stateCheckedAt).toEqual(
      checked[0]?.stateCheckedAt ?? null,
    );
  });

  test("a row marked unreachable after its lease ran out keeps that check over the late answer", async () => {
    const repo = repository();
    const row = await outcome(repo);
    const slow = slowGitHub("closed");
    const late = replica({
      repositories: [repo],
      unitOf: async () => `app:test:${repo}`,
      read: slow.read,
      leaseMs: 200,
    });
    const running = late.refresher.runOnce();
    await slow.askedOnce;
    await Bun.sleep(300);
    // The App is gone from the workspace by now.
    const next = replica({
      repositories: [],
      unitOf: async () => "",
      read: states(new Map()),
      unconnected: [repo],
    });
    await next.refresher.runOnce();
    const failed = await rowOf(row.id);
    expect(failed).toMatchObject({
      state: "open",
      checkError: "github_refused",
      leaseToken: null,
    });

    slow.release();
    await running;
    expect(await rowOf(row.id)).toMatchObject({
      state: "open",
      checkError: "github_refused",
      stateCheckedAt: failed.stateCheckedAt,
    });
  });

  test("a grant or unit lookup slower than the lease sends no read", async () => {
    for (const slow of ["grant", "unit"] as const) {
      const repo = repository();
      const row = await outcome(repo);
      const unit = `app:test:${repo}`;
      let reads = 0;
      const { refresher } = replica({
        repositories: [repo],
        unitOf: async () => unit,
        read: states(new Map()),
        leaseMs: 200,
        grant: async () => {
          if (slow === "grant") await Bun.sleep(300);
          return {
            api: {
              getPullRequest: async () => {
                reads += 1;
                return { pullRequest: answer(1, "open"), rateLimit: NO_LIMIT };
              },
            },
            unit: async () => {
              if (slow === "unit") await Bun.sleep(300);
              return unit;
            },
          } as unknown as GitHubGrant;
        },
      });
      await refresher.runOnce();
      expect([slow, reads]).toEqual([slow, 0]);
      expect(await rowOf(row.id)).toMatchObject({
        leaseToken: null,
        stateCheckedAt: null,
      });
    }
  });

  test("an App whose pinned installation is gone gets not_found when its token is refused; installed, forge_failed", async () => {
    const [gone, kept] = [repository(), repository()];
    const rows = [await outcome(gone), await outcome(kept)];
    const refused = async (): Promise<GitHubGrant | null> => {
      throw new ForgeCredentialError("GitHub installation token failed (404)");
    };
    for (const [repo, installed] of [
      [gone, false],
      [kept, true],
    ] as const) {
      const { refresher, calls } = replica({
        repositories: [repo],
        unitOf: async () => `app:test:${repo}`,
        read: states(new Map()),
        grant: refused,
        installed: async () => installed,
      });
      await refresher.runOnce();
      expect(calls).toEqual([]);
    }
    const checked = await Promise.all(rows.map((row) => rowOf(row.id)));
    expect(checked.map((row) => [row.state, row.checkError])).toEqual([
      ["open", "not_found"],
      ["open", "forge_failed"],
    ]);
    // The token was asked of GitHub after the claim: its share stays spent.
    expect((await quotaOf(`app:test:${gone}`))?.used).toBe(1);
  });

  test("a read whose granted connection spends from another unit than the claim goes back unread", async () => {
    const repo = repository();
    const row = await outcome(repo);
    const before = `app:test:${randomUUID()}`;
    const after = `app:test:${randomUUID()}`;
    let reads = 0;
    const { refresher } = replica({
      repositories: [repo],
      // Claimed under A, and the repository's connection is A again by the
      // time the read would go: only the grant's own connection tells.
      unitOf: async () => before,
      read: states(new Map()),
      grant: async () =>
        ({
          api: {
            getPullRequest: async () => {
              reads += 1;
              return { pullRequest: answer(1, "open"), rateLimit: NO_LIMIT };
            },
          },
          unit: async () => after,
        }) as unknown as GitHubGrant,
    });
    await refresher.runOnce();
    expect(reads).toBe(0);
    expect(await rowOf(row.id)).toMatchObject({
      leaseToken: null,
      stateCheckedAt: null,
    });
    expect((await quotaOf(before))?.used).toBe(1);
    expect(await quotaOf(after)).toBeUndefined();
  });

  test("rows whose lease ran out while earlier ones were read go back unread", async () => {
    const repo = repository();
    const unit = `app:test:${randomUUID()}`;
    const rows = [await outcome(repo), await outcome(repo)];
    const slow = slowGitHub("open");
    const { refresher, calls } = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: slow.read,
      leaseMs: 200,
    });
    const running = refresher.runOnce();
    await slow.askedOnce;
    await Bun.sleep(300);
    slow.release();
    await running;
    expect(calls).toHaveLength(1);
    const after = await Promise.all(rows.map((row) => rowOf(row.id)));
    expect(after.map((row) => row.leaseToken)).toEqual([null, null]);
    expect(after.filter((row) => row.stateCheckedAt === null)).toHaveLength(1);
  });

  test("two repositories of one PAT user spend from one unit; switching one to another user's PAT moves it to a new unit next pass", async () => {
    const [x, y] = [repository(), repository()];
    const rows = [await outcome(x), await outcome(y)];
    const user = `pat:test:${randomUUID()}`;
    const other = `pat:test:${randomUUID()}`;
    const units = new Map([
      [x, user],
      [y, user],
    ]);
    const { refresher } = replica({
      repositories: [x, y],
      unitOf: async (id) => units.get(id) ?? "",
      read: states(new Map()),
    });
    await refresher.runOnce();
    expect((await quotaOf(user))?.used).toBe(2);
    expect(await quotaOf(other)).toBeUndefined();

    units.set(y, other);
    await age(
      rows.map((row) => row.id),
      6,
    );
    await refresher.runOnce();
    expect((await quotaOf(user))?.used).toBe(3);
    expect((await quotaOf(other))?.used).toBe(1);
  });

  test("x-ratelimit-remaining under 20% pauses the unit until its reset, for every replica", async () => {
    const repo = repository();
    const unit = `app:test:${randomUUID()}`;
    const rows = [
      await outcome(repo),
      await outcome(repo),
      await outcome(repo),
    ];
    const reset = new Date(Date.now() + 10 * 60_000);
    const low = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: async (number) => ({
        pullRequest: answer(number, "open"),
        rateLimit: {
          limit: 5000,
          remaining: 999,
          reset,
          retryAfterSeconds: null,
        },
      }),
    });
    await low.refresher.runOnce();
    // The first answer paused the unit; the rest of the claim went back unread.
    expect(low.calls).toHaveLength(1);
    const after = await Promise.all(rows.map((row) => rowOf(row.id)));
    expect(after.filter((row) => row.stateCheckedAt !== null)).toHaveLength(1);
    expect(after.map((row) => row.leaseToken)).toEqual([null, null, null]);
    expect(await quotaOf(unit)).toMatchObject({
      rateLimit: 5000,
      pausedUntil: reset,
    });

    const other = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: states(new Map()),
    });
    await other.refresher.runOnce();
    expect(other.calls).toEqual([]);
  });

  test("a 429 pauses the unit until its reset and leaves the row as it was", async () => {
    const repo = repository();
    const unit = `app:test:${randomUUID()}`;
    const row = await outcome(repo);
    const reset = new Date(Date.now() + 5 * 60_000);
    const limited = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: async () => {
        throw new GitHubCallError("pull request read", 429, null, {
          limit: 5000,
          remaining: 0,
          reset,
          retryAfterSeconds: null,
        });
      },
    });
    await limited.refresher.runOnce();
    expect(await rowOf(row.id)).toMatchObject({
      state: "open",
      checkError: null,
      stateCheckedAt: null,
      leaseToken: null,
    });
    expect((await quotaOf(unit))?.pausedUntil).toEqual(reset);
    await limited.refresher.runOnce();
    expect(limited.calls).toHaveLength(1);
  });

  test("which rows are read: the interval table", async () => {
    const repo = repository();
    const unit = `app:test:${randomUUID()}`;
    const make = (
      state: PullState,
      createdDaysAgo: number,
      checkedMinutesAgo: number | null,
      closedDaysAgo: number | null = null,
    ) =>
      outcome(repo, {
        state,
        createdAt:
          sql`now() - make_interval(days => ${createdDaysAgo})` as unknown as Date,
        stateCheckedAt:
          checkedMinutesAgo === null
            ? null
            : (sql`now() - make_interval(mins => ${checkedMinutesAgo})` as unknown as Date),
        closedAt:
          closedDaysAgo === null
            ? null
            : (sql`now() - make_interval(days => ${closedDaysAgo})` as unknown as Date),
        mergedAt: state === "merged" ? new Date() : null,
      });
    const due = [
      await make("open", 0, null),
      await make("open", 0, 6),
      await make("open", 2, 61),
      await make("open", 40, 25 * 60),
      await make("closed", 10, 25 * 60, 10),
    ];
    // Read within their interval, merged, or closed over 30 days ago.
    await make("open", 0, 4);
    await make("open", 2, 50);
    await make("open", 40, 23 * 60);
    await make("closed", 10, 23 * 60, 10);
    await make("closed", 40, 25 * 60, 31);
    await make("merged", 0, null);
    const claimed = await store.claim({
      quotaKey: unit,
      repositoryIds: [repo],
      max: 50,
      leaseMs: 60_000,
    });
    expect(claimed.map((row) => row.id).sort()).toEqual(
      due.map((row) => row.id).sort(),
    );
  });

  test("open → merged, open → closed → open, and a 404 is not_found with the state kept", async () => {
    const repo = repository();
    const unit = `app:test:${randomUUID()}`;
    const merging = await outcome(repo);
    const reopening = await outcome(repo);
    const ids = [merging.id, reopening.id];
    const github = new Map<number, PullState>();
    let missing = false;
    const { refresher, calls } = replica({
      repositories: [repo],
      unitOf: async () => unit,
      read: async (number) => {
        if (missing) {
          throw new GitHubCallError("pull request read", 404, null, NO_LIMIT);
        }
        return {
          pullRequest: answer(number, github.get(number) ?? "open"),
          rateLimit: NO_LIMIT,
        };
      },
    });
    const pass = async () => {
      await refresher.runOnce();
      await age(ids, 6);
      return Promise.all(ids.map(rowOf));
    };

    const [opened] = await pass();
    expect(opened).toMatchObject({ state: "open", checkError: null });
    expect(opened?.stateChangedAt).toEqual(merging.stateChangedAt);

    github.set(Number(merging.externalId), "merged");
    github.set(Number(reopening.externalId), "closed");
    const [merged, closed] = await pass();
    expect(merged).toMatchObject({
      state: "merged",
      mergedAt: new Date("2026-10-31T00:00:00.000Z"),
      metadata: expect.objectContaining({
        title: "t".repeat(200),
        adopted: false,
        merge_commit_sha: "d".repeat(40),
        additions: 2,
      }),
    });
    expect(merged?.stateChangedAt.getTime()).toBeGreaterThan(
      merging.stateChangedAt.getTime(),
    );
    expect(closed).toMatchObject({ state: "closed", mergedAt: null });
    expect(closed?.closedAt).not.toBeNull();

    // Closed is read again after a day; merged never again.
    await age(ids, 25 * 60);
    github.set(Number(reopening.externalId), "open");
    const readsOfMerged = () =>
      calls.filter((number) => number === Number(merging.externalId)).length;
    const before = readsOfMerged();
    const [stillMerged, reopened] = await pass();
    expect(readsOfMerged()).toBe(before);
    expect(stillMerged?.state).toBe("merged");
    expect(reopened).toMatchObject({ state: "open", closedAt: null });
    expect(reopened?.stateChangedAt.getTime()).toBeGreaterThan(
      closed?.stateChangedAt.getTime() ?? 0,
    );

    missing = true;
    const [, gone] = await pass();
    expect(gone).toMatchObject({ state: "open", checkError: "not_found" });
    expect(gone?.stateCheckedAt?.getTime()).toBeGreaterThan(
      reopened?.stateCheckedAt?.getTime() ?? 0,
    );

    missing = false;
    const [, back] = await pass();
    expect(back).toMatchObject({ state: "open", checkError: null });
  });

  test("a review outcome is never read from GitHub", async () => {
    const repo = repository();
    const review = await outcome(repo, {
      type: "github_review",
      url: `https://github.com/acme/${repo}/pull/9#pullrequestreview-77`,
      externalId: "77",
      state: "submitted",
      metadata: {
        number: 9,
        event: "APPROVE",
        commit_id: "e".repeat(40),
        opened_by_session_id: null,
      },
    });
    const { refresher, calls } = replica({
      repositories: [repo],
      unitOf: async () => `app:test:${randomUUID()}`,
      read: async (number) => ({
        pullRequest: answer(number, "open"),
        rateLimit: NO_LIMIT,
      }),
    });
    await refresher.runOnce();
    expect(calls).toEqual([]);
    expect(await rowOf(review.id)).toMatchObject({
      state: "submitted",
      stateCheckedAt: null,
      leaseToken: null,
    });
  });

  test("lists a session's outcomes for its owner only, oldest first", async () => {
    const repo = repository();
    const first = await outcome(repo);
    const second = await outcome(repo, {
      sessionId: first.sessionId,
      createdAt: new Date(first.createdAt.getTime() + 1000),
    });
    const review = await outcome(repo, {
      sessionId: first.sessionId,
      type: "github_review",
      url: `https://github.com/acme/${repo}/pull/1#pullrequestreview-7`,
      externalId: "7",
      state: "submitted",
      metadata: {
        number: 1,
        event: "APPROVE",
        commit_id: "abc",
        opened_by_session_id: null,
      },
      createdAt: new Date(first.createdAt.getTime() + 2000),
    });
    const listed = await store.list(OWNER, first.sessionId.toUpperCase());
    expect(listed?.map((item) => item.id)).toEqual([
      first.id,
      second.id,
      review.id,
    ]);
    expect(() =>
      listSessionOutcomesResponseSchema.parse({ items: listed }),
    ).not.toThrow();
    expect(listed?.[2]).toMatchObject({
      type: "github_review",
      state: "submitted",
      external_id: "7",
      metadata: {
        number: 1,
        event: "APPROVE",
        commit_id: "abc",
        opened_by_session_id: null,
      },
    });
    // The fixture row has no title, like one written before titles were kept.
    expect(listed?.[0]).toMatchObject({
      type: "github_pull_request",
      url: first.url,
      repository_id: repo,
      external_id: first.externalId,
      state: "open",
      state_checked_at: null,
      check_error: null,
      metadata: {
        title: null,
        head: "agent/x",
        base: "main",
        adopted: false,
        merge_commit_sha: null,
        additions: null,
        deletions: null,
        changed_files: null,
        commits: null,
      },
    });
    expect(await store.list("someone-else", first.sessionId)).toBeNull();
    expect(await store.list(OWNER, randomUUID())).toBeNull();
    expect(await store.list(OWNER, await session(repo))).toEqual([]);
  });

  test("a session's refusals are its failed gate receipts with a reason, newest ten first", async () => {
    const gate = createPostgresGitHubGateStore(db);
    const repo = repository();
    const sessionId = await session(repo);
    const elsewhere = await session(repo);
    const record = (
      id: string,
      operation: "mint_github_token" | "dispatch_workflow",
      status: "succeeded" | "failed",
      result: Record<string, unknown>,
    ) =>
      gate.recordReceipt({
        ownerId: OWNER,
        sessionId: id,
        actor: null,
        operation,
        status,
        result: { session_id: id, ...result },
        error:
          status === "failed"
            ? { code: "GITHUB_REFUSED", message: "GitHub work refused" }
            : null,
      });
    const written: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      written.push(
        await record(sessionId, "mint_github_token", "failed", {
          purpose: "push",
          reason_code: "github_disabled",
        }),
      );
    }
    const dispatched = await record(sessionId, "dispatch_workflow", "failed", {
      purpose: "dispatch",
      reason_code: "workflow_not_allowed",
    });
    await record(sessionId, "mint_github_token", "succeeded", {
      purpose: "clone",
    });
    await record(elsewhere, "mint_github_token", "failed", {
      purpose: "push",
      reason_code: "github_disabled",
    });

    const refusals = (await store.refusals(OWNER, sessionId, 10)) ?? [];
    expect(refusals).toHaveLength(10);
    expect(refusals[0]).toMatchObject({
      receipt_id: dispatched,
      operation: "dispatch_workflow",
      purpose: "dispatch",
      reason_code: "workflow_not_allowed",
    });
    expect(refusals.slice(1).map((item) => item.receipt_id)).toEqual(
      written.slice(2).reverse(),
    );
    expect(await store.refusals("someone-else", sessionId, 10)).toBeNull();
    expect(await store.refusals(OWNER, elsewhere, 10)).toEqual([
      expect.objectContaining({ reason_code: "github_disabled" }),
    ]);

    // Receipts naming a reason or purpose this build does not know (a newer
    // image wrote them) do not push the known ones out of the ten.
    for (let index = 0; index < 10; index += 1) {
      await record(sessionId, "mint_github_token", "failed", {
        purpose: index % 2 === 0 ? "push" : "a_later_purpose",
        reason_code: index % 2 === 0 ? "a_later_reason" : "github_disabled",
      });
    }
    expect(
      ((await store.refusals(OWNER, sessionId, 10)) ?? []).map(
        (item) => item.receipt_id,
      ),
    ).toEqual([dispatched, ...written.slice(2).reverse()]);
  });

  test("a merge the gate refused is listed, and one the pull request service refused is not", async () => {
    const gate = createPostgresGitHubGateStore(db);
    const sessionId = await session(repository());
    const record = (result: Record<string, unknown>) =>
      gate.recordReceipt({
        ownerId: OWNER,
        sessionId,
        actor: null,
        operation: "merge_pull_request",
        status: "failed",
        result: { session_id: sessionId, ...result },
        error: { code: "GITHUB_REFUSED", message: "GitHub work refused" },
      });
    const refused = await record({
      purpose: "merge",
      reason_code: "merge_off",
    });
    // The service's refusals name a pull request reason and no purpose.
    await record({ reason_code: "merge_blocked" });
    expect(await store.refusals(OWNER, sessionId, 10)).toEqual([
      expect.objectContaining({
        receipt_id: refused,
        operation: "merge_pull_request",
        purpose: "merge",
        reason_code: "merge_off",
      }),
    ]);
  });
});
