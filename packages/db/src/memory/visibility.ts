import type { MemoryDocumentOperation, MemoryViewer } from "@werft-ai/platform";
import { inArray, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  memoryCandidateReleases,
  memoryCandidates,
  memoryDocuments,
  memoryRevisions,
  memoryTombstones,
} from "../schema.ts";

// The SQL form of `memoryDocumentVisible` and `memoryRevisionVisible` in
// @werft-ai/platform; memory-visibility.integration.test.ts holds the two to
// the same answers. The conditions name `memory_documents` unaliased, so the
// query selects from it (joined to `memory_revisions` for history).

const document = memoryDocuments;
const ancestor = alias(memoryDocuments, "memory_ancestor");
const ancestorTombstone = alias(memoryTombstones, "memory_ancestor_tombstone");

const timestamptz = (at: Date) => sql`${at.toISOString()}::timestamptz`;

function notGone(): SQL {
  return sql`${document.state} <> 'deleted' AND NOT EXISTS (SELECT 1 FROM ${memoryTombstones} WHERE ${memoryTombstones.documentId} = ${document.id})`;
}

// An alias in a raw template renders as its name alone, so the FROM clauses
// below spell out the table before it.
// Every id in `ancestor_ids` must name a live row: one that was hard-deleted
// (a purged session's memory) hides its descendants like a tombstone does.
function ancestorsAll(condition: SQL): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM unnest(${document.ancestorIds}) AS memory_lineage(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM ${memoryDocuments} ${ancestor}
      WHERE ${ancestor.id} = memory_lineage.id
        AND ${ancestor.state} <> 'deleted'
        AND NOT EXISTS (SELECT 1 FROM ${memoryTombstones} ${ancestorTombstone} WHERE ${ancestorTombstone.documentId} = ${ancestor.id})
        AND ${condition}
    )
  )`;
}

function lineageAlive(): SQL {
  return sql`${notGone()} AND ${ancestorsAll(sql`true`)}`;
}

function lineageClean(at: Date): SQL {
  return sql`${notGone()}
    AND (${document.expiresAt} IS NULL OR ${document.expiresAt} > ${timestamptz(at)})
    AND ${ancestorsAll(sql`${ancestor.state} <> 'quarantined' AND (${ancestor.expiresAt} IS NULL OR ${ancestor.expiresAt} > ${timestamptz(at)})`)}`;
}

function canAdopt(viewer: MemoryViewer): SQL {
  if (viewer.userId === null) {
    return sql`false`;
  }
  return sql`CASE ${document.scope}
    WHEN 'personal' THEN ${document.subjectUserId} IS NOT DISTINCT FROM ${viewer.userId}::uuid
    WHEN 'agent' THEN coalesce(${inArray(document.agentId, [...viewer.adoptAgentIds])}, false)
    WHEN 'workspace' THEN ${sql.raw(viewer.adoptWorkspace ? "true" : "false")}
    ELSE false END`;
}

export function memoryDocumentVisibleSql(
  operation: MemoryDocumentOperation,
  viewer: MemoryViewer,
  at: Date,
): SQL {
  switch (operation) {
    case "retrieve":
      return sql`(${document.state} = 'active'
        AND EXISTS (SELECT 1 FROM ${memoryRevisions} WHERE ${memoryRevisions.documentId} = ${document.id} AND ${memoryRevisions.revision} = ${document.currentRevision} AND ${memoryRevisions.scanStatus} = 'clean')
        AND ${lineageClean(at)})`;
    case "candidate_queue": {
      const isReleaser =
        viewer.userId === null
          ? sql`false`
          : sql`${memoryCandidates.releaserUserId} = ${viewer.userId}::uuid`;
      const isReleaserOrSubject =
        viewer.userId === null
          ? sql`false`
          : sql`(${memoryCandidates.releaserUserId} = ${viewer.userId}::uuid OR ${viewer.userId}::uuid = ANY(${document.personalSubjects}))`;
      const releasedBy = (user: SQL) =>
        sql`EXISTS (SELECT 1 FROM ${memoryCandidateReleases} WHERE ${memoryCandidateReleases.documentId} = ${memoryCandidates.documentId} AND ${memoryCandidateReleases.userId} = ${user})`;
      return sql`(${document.state} = 'candidate'
        AND ${lineageClean(at)}
        AND EXISTS (
          SELECT 1 FROM ${memoryCandidates}
          WHERE ${memoryCandidates.documentId} = ${document.id}
            AND ${memoryCandidates.expiresAt} > ${timestamptz(at)}
            AND CASE
              WHEN NOT ${releasedBy(sql`${memoryCandidates.releaserUserId}`)} THEN ${isReleaser}
              WHEN EXISTS (
                SELECT 1 FROM unnest(${document.personalSubjects}) AS memory_subject(id)
                WHERE NOT ${releasedBy(sql`memory_subject.id`)}
              ) THEN ${isReleaserOrSubject}
              ELSE ${canAdopt(viewer)} END
        ))`;
    }
    case "quarantine_review":
      return sql`(${document.state} = 'quarantined' AND ${lineageAlive()} AND ${canAdopt(viewer)})`;
  }
}

export function memoryRevisionVisibleSql(): SQL {
  return sql`(${memoryRevisions.adoptedAt} IS NOT NULL AND ${memoryRevisions.scanStatus} = 'clean' AND ${lineageAlive()})`;
}
