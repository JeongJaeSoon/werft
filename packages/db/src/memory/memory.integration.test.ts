import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  MEMORY_OPERATION_VALUES,
  type MemoryScanStatus,
  type MemoryScope,
  type MemoryState,
} from "@werft-ai/contracts";
import {
  type MemoryDocumentFacts,
  type MemoryDocumentOperation,
  type MemoryViewer,
  memoryDocumentVisible,
  memoryRevisionVisible,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  memoryCandidates,
  memoryDocuments,
  memoryRevisions,
  memoryTombstones,
} from "../schema.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import {
  memoryDocumentVisibleSql,
  memoryRevisionVisibleSql,
} from "./visibility.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const HASH = "b".repeat(64);
const AT = new Date("2026-11-20T00:00:00Z");
const PAST = new Date("2026-11-19T00:00:00Z");
const FUTURE = new Date("2026-11-21T00:00:00Z");

integration("memory schema (0292)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const sessionId = randomUUID();

  type Doc = {
    scope?: MemoryScope;
    state?: MemoryState;
    workspace?: string;
    key?: Partial<
      Record<"session_id" | "subject_user_id" | "agent_id", string>
    >;
    ancestors?: string[];
    expiresAt?: Date | null;
    revisions?: { scan: MemoryScanStatus; adopted: boolean }[];
  };

  // Rows with a current revision go in as candidates first: the revision
  // must exist before the document can point at it.
  async function doc(spec: Doc = {}): Promise<string> {
    const id = randomUUID();
    const scope = spec.scope ?? "agent";
    const key =
      spec.key ??
      {
        session: { session_id: sessionId },
        personal: { subject_user_id: alice },
        agent: { agent_id: agentId },
        workspace: {},
      }[scope];
    await pool.query(
      `INSERT INTO memory_documents (id, workspace_id, scope, session_id, subject_user_id, agent_id, state, ancestor_ids, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'candidate', $7::uuid[], $8)`,
      [
        id,
        spec.workspace ?? workspaceId,
        scope,
        key.session_id ?? null,
        key.subject_user_id ?? null,
        key.agent_id ?? null,
        spec.ancestors ?? [],
        spec.expiresAt ?? null,
      ],
    );
    const revisions = spec.revisions ?? [{ scan: "clean", adopted: true }];
    for (const [index, revision] of revisions.entries()) {
      await pool.query(
        `INSERT INTO memory_revisions (document_id, revision, title, body, body_sha256, scan_status, author_session_id, adopted_at)
         VALUES ($1, $2, 't', 'body', $3, $4, $5, $6)`,
        [
          id,
          index + 1,
          HASH,
          revision.scan,
          sessionId,
          revision.adopted ? PAST : null,
        ],
      );
    }
    await pool.query(
      "UPDATE memory_documents SET state = $2, current_revision = $3 WHERE id = $1",
      [
        id,
        spec.state ?? "active",
        revisions.length > 0 ? revisions.length : null,
      ],
    );
    return id;
  }

  async function candidate(
    spec: Doc & { released?: boolean; releaser?: string },
  ): Promise<string> {
    const id = await doc({ ...spec, state: "candidate", revisions: [] });
    await pool.query(
      `INSERT INTO memory_candidates (document_id, workspace_id, source_session_id, releaser_user_id, released_by, released_at, released_body_sha256, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        workspaceId,
        sessionId,
        spec.releaser ?? alice,
        spec.released ? alice : null,
        spec.released ? PAST : null,
        spec.released ? HASH : null,
        FUTURE,
      ],
    );
    return id;
  }

  const tombstone = (id: string) =>
    pool.query(
      "INSERT INTO memory_tombstones (document_id, workspace_id, kind, deleted_by) VALUES ($1, $2, 'normal', $3)",
      [id, workspaceId, alice],
    );

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "memory_schema" });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
    for (const id of [workspaceId, otherWorkspaceId]) {
      await pool.query(
        "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
        [id, `ws-${id.slice(0, 8)}`],
      );
    }
    for (const id of [alice, bob]) {
      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
        [id, `${id}@example.invalid`],
      );
    }
    for (const [id, workspace] of [
      [agentId, workspaceId],
      [otherAgentId, otherWorkspaceId],
    ] as const) {
      const team = await fixtureTeamSql(pool, workspace);
      await pool.query(
        "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, $4, 'agent', 'active')",
        [id, workspace, team, `agent-${id.slice(0, 8)}`],
      );
    }
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id, created_by_user_id, status)
       VALUES ($1, 'svc', 'https://example.invalid/r.git', 'main', $2, $3, 'stopped')`,
      [sessionId, workspaceId, alice],
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  test("a session starts with no personal memory subjects", async () => {
    const { rows } = await pool.query(
      "SELECT personal_subjects FROM sessions WHERE id = $1",
      [sessionId],
    );
    expect(rows).toEqual([{ personal_subjects: [] }]);
  });

  test("a document fills exactly its scope's key", async () => {
    for (const scope of [
      "session",
      "personal",
      "agent",
      "workspace",
    ] as const) {
      await doc({ scope });
    }
    const refused: Doc[] = [
      { scope: "workspace", key: { agent_id: agentId } },
      { scope: "agent", key: {} },
      { scope: "agent", key: { agent_id: agentId, subject_user_id: alice } },
      {
        scope: "personal",
        key: { subject_user_id: alice, session_id: sessionId },
      },
      { scope: "session", key: { agent_id: agentId } },
    ];
    for (const spec of refused) {
      await expect(doc(spec)).rejects.toThrow(
        /memory_documents_scope_key_check/,
      );
    }
    await expect(
      doc({ scope: "space" as MemoryScope, key: {} }),
    ).rejects.toThrow(/memory_documents_scope_check/);
  });

  test("a state outside the lifecycle is refused, and an active document needs a revision", async () => {
    await expect(doc({ state: "purged" as MemoryState })).rejects.toThrow(
      /memory_documents_state_check/,
    );
    await expect(
      pool.query(
        "INSERT INTO memory_documents (id, workspace_id, scope, agent_id, state) VALUES ($1, $2, 'agent', $3, 'active')",
        [randomUUID(), workspaceId, agentId],
      ),
    ).rejects.toThrow(/memory_documents_active_revision_check/);
  });

  test("an agent and a lineage link stay in the document's workspace", async () => {
    await expect(
      doc({ scope: "agent", key: { agent_id: otherAgentId } }),
    ).rejects.toThrow(/memory_documents_agent_fk/);
    const here = await doc();
    const there = await doc({
      workspace: otherWorkspaceId,
      scope: "workspace",
    });
    await expect(
      pool.query(
        "INSERT INTO memory_derivations (workspace_id, document_id, derives_from_id) VALUES ($1, $2, $3)",
        [workspaceId, here, there],
      ),
    ).rejects.toThrow(/memory_derivations_derives_from_fk/);
  });

  test("a revision's content never changes and it is not deleted on its own", async () => {
    const id = await doc({
      revisions: [{ scan: "unscanned", adopted: false }],
    });
    const where = "WHERE document_id = $1 AND revision = 1";
    await expect(
      pool.query(`UPDATE memory_revisions SET body = 'changed' ${where}`, [id]),
    ).rejects.toThrow(/is immutable/);
    await pool.query(
      `UPDATE memory_revisions SET scan_status = 'clean', adopted_at = $2 ${where}`,
      [id, PAST],
    );
    await expect(
      pool.query(`UPDATE memory_revisions SET adopted_at = $2 ${where}`, [
        id,
        AT,
      ]),
    ).rejects.toThrow(/is immutable/);
    await expect(
      pool.query(`DELETE FROM memory_revisions ${where}`, [id]),
    ).rejects.toThrow(/is immutable/);
    await pool.query("DELETE FROM memory_documents WHERE id = $1", [id]);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM memory_revisions WHERE document_id = $1`,
      [id],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  describe("per-operation filters", () => {
    const named: Record<string, string> = {};

    beforeAll(async () => {
      await pool.query("DELETE FROM memory_documents");
      const clean = await doc();
      const tombstoned = await doc();
      await tombstone(tombstoned);
      const quarantinedAncestor = await doc({ state: "quarantined" });
      const expiredAncestor = await doc({ expiresAt: PAST });
      Object.assign(named, {
        clean,
        tombstoned,
        quarantinedAncestor,
        expiredAncestor,
        session: await doc({ scope: "session" }),
        workspace: await doc({ scope: "workspace" }),
        personalBob: await doc({
          scope: "personal",
          key: { subject_user_id: bob },
        }),
        unscanned: await doc({
          revisions: [{ scan: "unscanned", adopted: true }],
        }),
        olderQuarantinedRevision: await doc({
          revisions: [
            { scan: "quarantined", adopted: true },
            { scan: "clean", adopted: false },
            { scan: "clean", adopted: true },
          ],
        }),
        deletedState: await doc({ state: "deleted" }),
        superseded: await doc({ state: "superseded" }),
        expiring: await doc({ expiresAt: FUTURE }),
        childOk: await doc({ ancestors: [clean] }),
        childOfTombstoned: await doc({ ancestors: [clean, tombstoned] }),
        childOfQuarantined: await doc({ ancestors: [quarantinedAncestor] }),
        childOfExpired: await doc({ ancestors: [expiredAncestor] }),
        childOfMissing: await doc({ ancestors: [randomUUID()] }),
        quarantinedAgent: await doc({ state: "quarantined" }),
        quarantinedPersonal: await doc({
          scope: "personal",
          state: "quarantined",
          key: { subject_user_id: alice },
        }),
        quarantinedChildOfTombstoned: await doc({
          state: "quarantined",
          ancestors: [tombstoned],
        }),
        unreleased: await candidate({}),
        unreleasedForBob: await candidate({ releaser: bob }),
        releasedAgent: await candidate({ released: true }),
        releasedPersonalBob: await candidate({
          released: true,
          scope: "personal",
          key: { subject_user_id: bob },
        }),
        releasedWorkspace: await candidate({
          released: true,
          scope: "workspace",
        }),
        releasedExpired: await candidate({ released: true, expiresAt: PAST }),
        releasedChildOfQuarantined: await candidate({
          released: true,
          ancestors: [quarantinedAncestor],
        }),
        candidateWithoutRow: await doc({ state: "candidate", revisions: [] }),
      });
    }, 60_000);

    const viewers = {
      tool: { userId: null, adoptAgentIds: [], adoptWorkspace: false },
      aliceAgentAdopter: {
        userId: alice,
        adoptAgentIds: [agentId],
        adoptWorkspace: false,
      },
      bobWorkspaceAdopter: {
        userId: bob,
        adoptAgentIds: [],
        adoptWorkspace: true,
      },
      aliceOnly: { userId: alice, adoptAgentIds: [], adoptWorkspace: false },
    } satisfies Record<string, MemoryViewer>;

    async function facts() {
      const documents = await db
        .select()
        .from(memoryDocuments)
        .where(eq(memoryDocuments.workspaceId, workspaceId));
      const tombstoned = new Set(
        (await db.select().from(memoryTombstones)).map((row) => row.documentId),
      );
      const revisions = await db.select().from(memoryRevisions);
      const candidates = new Map(
        (await db.select().from(memoryCandidates)).map((row) => [
          row.documentId,
          row,
        ]),
      );
      const byId = new Map<string, MemoryDocumentFacts>();
      for (const row of documents) {
        const current = revisions.find(
          (revision) =>
            revision.documentId === row.id &&
            revision.revision === row.currentRevision,
        );
        const pending = candidates.get(row.id);
        byId.set(row.id, {
          scope: row.scope as MemoryScope,
          state: row.state as MemoryState,
          subjectUserId: row.subjectUserId,
          agentId: row.agentId,
          ancestorIds: row.ancestorIds,
          expiresAt: row.expiresAt,
          tombstoned: tombstoned.has(row.id),
          currentScanStatus: (current?.scanStatus as MemoryScanStatus) ?? null,
          candidate: pending
            ? {
                releaserUserId: pending.releaserUserId,
                releasedAt: pending.releasedAt,
              }
            : null,
        });
      }
      return { byId, revisions };
    }

    const sorted = (ids: Iterable<string>) => [...ids].sort();
    const names = (ids: Iterable<string>) =>
      sorted(
        [...ids].map(
          (id) => Object.entries(named).find(([, v]) => v === id)?.[0] ?? id,
        ),
      );

    async function sqlVisible(
      operation: MemoryDocumentOperation,
      viewer: MemoryViewer,
    ) {
      const rows = await db
        .select({ id: memoryDocuments.id })
        .from(memoryDocuments)
        .where(
          and(
            eq(memoryDocuments.workspaceId, workspaceId),
            memoryDocumentVisibleSql(operation, viewer, AT),
          ),
        );
      return sorted(rows.map((row) => row.id));
    }

    test("the TS and SQL forms agree for every operation and viewer", async () => {
      const { byId } = await facts();
      const operations = MEMORY_OPERATION_VALUES.filter(
        (operation): operation is MemoryDocumentOperation =>
          operation !== "revision_history",
      );
      for (const operation of operations) {
        for (const [viewerName, viewer] of Object.entries(viewers)) {
          const expected = sorted(
            [...byId]
              .filter(([, document]) =>
                memoryDocumentVisible(operation, document, byId, viewer, AT),
              )
              .map(([id]) => id),
          );
          const actual = await sqlVisible(operation, viewer);
          expect({ operation, viewerName, ids: names(actual) }).toEqual({
            operation,
            viewerName,
            ids: names(expected),
          });
        }
      }
    });

    test("the filters hide what §5 says they hide", async () => {
      expect(names(await sqlVisible("retrieve", viewers.tool))).toEqual(
        sorted([
          "childOk",
          "clean",
          "expiring",
          "olderQuarantinedRevision",
          "personalBob",
          "session",
          "workspace",
        ]),
      );
      expect(
        names(await sqlVisible("candidate_queue", viewers.aliceAgentAdopter)),
      ).toEqual(sorted(["releasedAgent", "unreleased"]));
      expect(
        names(await sqlVisible("candidate_queue", viewers.bobWorkspaceAdopter)),
      ).toEqual(
        sorted([
          "releasedPersonalBob",
          "releasedWorkspace",
          "unreleasedForBob",
        ]),
      );
      expect(
        names(await sqlVisible("quarantine_review", viewers.aliceAgentAdopter)),
      ).toEqual(
        sorted([
          "quarantinedAgent",
          "quarantinedAncestor",
          "quarantinedPersonal",
        ]),
      );
      expect(await sqlVisible("quarantine_review", viewers.tool)).toEqual([]);
    });

    test("revision history agrees too, and shows only adopted clean revisions of live lineages", async () => {
      const { byId, revisions } = await facts();
      const key = (documentId: string, revision: number) =>
        `${names([documentId])[0]}#${revision}`;
      const expected = revisions
        .filter((revision) => {
          const document = byId.get(revision.documentId);
          return (
            document !== undefined &&
            memoryRevisionVisible(
              {
                scanStatus: revision.scanStatus as MemoryScanStatus,
                adoptedAt: revision.adoptedAt,
              },
              document,
              byId,
            )
          );
        })
        .map((revision) => key(revision.documentId, revision.revision))
        .sort();
      const rows = await db
        .select({
          documentId: memoryRevisions.documentId,
          revision: memoryRevisions.revision,
        })
        .from(memoryRevisions)
        .innerJoin(
          memoryDocuments,
          eq(memoryDocuments.id, memoryRevisions.documentId),
        )
        .where(
          and(
            eq(memoryDocuments.workspaceId, workspaceId),
            memoryRevisionVisibleSql(),
          ),
        );
      const actual = rows
        .map((row) => key(row.documentId, row.revision))
        .sort();
      expect(actual).toEqual(expected);
      expect(actual).toContain("olderQuarantinedRevision#3");
      for (const hidden of [
        "olderQuarantinedRevision#1",
        "olderQuarantinedRevision#2",
        "tombstoned#1",
        "childOfTombstoned#1",
        "unscanned#1",
      ]) {
        expect(actual).not.toContain(hidden);
      }
    });
  });
});
