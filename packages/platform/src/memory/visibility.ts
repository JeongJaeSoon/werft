import type {
  MemoryOperation,
  MemoryScanStatus,
  MemoryScope,
  MemoryState,
} from "@werft-ai/contracts";

/** What the filters read of a document up its lineage. */
export interface MemoryLineageFacts {
  readonly state: MemoryState;
  readonly expiresAt: Date | null;
  readonly tombstoned: boolean;
}

export interface MemoryDocumentFacts extends MemoryLineageFacts {
  readonly scope: MemoryScope;
  readonly subjectUserId: string | null;
  readonly agentId: string | null;
  readonly ancestorIds: readonly string[];
  readonly personalSubjects: readonly string[];
  /** The scan result of `current_revision`; null when there is none. */
  readonly currentScanStatus: MemoryScanStatus | null;
  readonly candidate: {
    readonly releaserUserId: string;
    readonly expiresAt: Date;
    /** Everyone who has released it so far. */
    readonly releasedBy: readonly string[];
  } | null;
}

export interface MemoryRevisionFacts {
  readonly scanStatus: MemoryScanStatus;
  readonly adoptedAt: Date | null;
}

/**
 * Who is looking, as the common access decision resolved it: the scopes this
 * person may adopt into. The filter narrows what the decision allowed; it
 * never grants.
 */
export interface MemoryViewer {
  readonly userId: string | null;
  readonly adoptAgentIds: readonly string[];
  readonly adoptWorkspace: boolean;
}

export type MemoryDocumentOperation = Exclude<
  MemoryOperation,
  "revision_history"
>;

const gone = (facts: MemoryLineageFacts) =>
  facts.tombstoned || facts.state === "deleted";
const expired = (facts: MemoryLineageFacts, at: Date) =>
  facts.expiresAt !== null && facts.expiresAt <= at;

// An ancestor missing from `ancestors` counts as gone: a lineage that cannot
// be read is not shown.
function lineageAlive(
  document: MemoryDocumentFacts,
  ancestors: ReadonlyMap<string, MemoryLineageFacts>,
): boolean {
  return (
    !gone(document) &&
    document.ancestorIds.every((id) => {
      const ancestor = ancestors.get(id);
      return ancestor !== undefined && !gone(ancestor);
    })
  );
}

function lineageClean(
  document: MemoryDocumentFacts,
  ancestors: ReadonlyMap<string, MemoryLineageFacts>,
  at: Date,
): boolean {
  return (
    lineageAlive(document, ancestors) &&
    !expired(document, at) &&
    document.ancestorIds.every((id) => {
      const ancestor = ancestors.get(id);
      return (
        ancestor !== undefined &&
        ancestor.state !== "quarantined" &&
        !expired(ancestor, at)
      );
    })
  );
}

function canAdopt(document: MemoryDocumentFacts, viewer: MemoryViewer) {
  if (viewer.userId === null) {
    return false;
  }
  switch (document.scope) {
    case "personal":
      return document.subjectUserId === viewer.userId;
    case "agent":
      return (
        document.agentId !== null &&
        viewer.adoptAgentIds.includes(document.agentId)
      );
    case "workspace":
      return viewer.adoptWorkspace;
    case "session":
      return false;
  }
}

/**
 * Step 4 of memory-layer.md §5 for one document. Search, read and injection
 * see only active, clean documents whose whole lineage is alive and
 * unexpired. The candidate queue shows an unexpired candidate to its source's
 * owner until they release it, then to them and the people in its
 * `personal_subjects` until all of those have, and only then to the target
 * scope's adopters (taint, §4). Quarantine is for
 * the adopters' review only. The db package's `memoryDocumentVisibleSql` is
 * the same rule as a query condition.
 */
export function memoryDocumentVisible(
  operation: MemoryDocumentOperation,
  document: MemoryDocumentFacts,
  ancestors: ReadonlyMap<string, MemoryLineageFacts>,
  viewer: MemoryViewer,
  at: Date,
): boolean {
  switch (operation) {
    case "retrieve":
      return (
        document.state === "active" &&
        document.currentScanStatus === "clean" &&
        lineageClean(document, ancestors, at)
      );
    case "candidate_queue": {
      const candidate = document.candidate;
      if (
        document.state !== "candidate" ||
        candidate === null ||
        candidate.expiresAt <= at ||
        !lineageClean(document, ancestors, at)
      ) {
        return false;
      }
      const released = (userId: string) =>
        candidate.releasedBy.includes(userId);
      if (!released(candidate.releaserUserId)) {
        return viewer.userId === candidate.releaserUserId;
      }
      if (!document.personalSubjects.every(released)) {
        return (
          viewer.userId !== null &&
          (viewer.userId === candidate.releaserUserId ||
            document.personalSubjects.includes(viewer.userId))
        );
      }
      return canAdopt(document, viewer);
    }
    case "quarantine_review":
      return (
        document.state === "quarantined" &&
        lineageAlive(document, ancestors) &&
        canAdopt(document, viewer)
      );
  }
}

/**
 * A revision shows in history only if it was adopted and scanned clean, and
 * never once its document or an ancestor is deleted. Whether the viewer may
 * read the document at all is the access decision's.
 */
export function memoryRevisionVisible(
  revision: MemoryRevisionFacts,
  document: MemoryDocumentFacts,
  ancestors: ReadonlyMap<string, MemoryLineageFacts>,
): boolean {
  return (
    revision.adoptedAt !== null &&
    revision.scanStatus === "clean" &&
    lineageAlive(document, ancestors)
  );
}
