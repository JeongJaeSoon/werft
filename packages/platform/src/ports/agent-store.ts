import type {
  AgentCard,
  AgentDetail,
  AgentRelease,
  AgentSummary,
  AgentVersion,
  CountAgentsResponse,
  ListAgentsQuery,
  ListAgentsResponse,
  ModelSource,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { OutsideAgentAccess, Principal } from "../musterrolle/policy.ts";
import type { SessionViewer } from "./session-share-store.ts";

/** Who lists agents, and what the workspace lets members outside one see. */
export interface AgentReader {
  userId: string;
  outsideAccess: OutsideAgentAccess;
}

/** A release as the service builds it; the store stamps the times. */
export type NewAgentRelease = Omit<
  AgentRelease,
  | "created_by"
  | "created_at"
  | "approved_by"
  | "approved_at"
  | "label"
  | "activated_at"
  | "deactivated_at"
> & { created_by: string };

// Every write re-checks the acting person's membership under a share lock in
// its own transaction; `actor_inactive` is an offboarding that won that race.
// A change to an existing agent also re-checks, under the agent row's lock,
// the right to make it: `outranked` is a demotion or a managing-team change
// that won it.
type Inactive = { outcome: "actor_inactive" };
type Outranked = { outcome: "outranked" };

/** Roles holding the right outright; anyone else must administer the agent. */
type ManagerRoles = {
  managerRoles: readonly WorkspaceRole[];
  /**
   * Also required of the person, whatever team right they hold: a rollout
   * acts for a profile's author and needs them to still be an owner or admin.
   */
  requireRoles?: readonly WorkspaceRole[];
};

/**
 * An agent as the store reads it. `effective_behavior` needs the catalog, so
 * the service adds it.
 */
export type AgentRecord = Omit<AgentDetail, "effective_behavior">;

export type CreateAgentResult =
  | { outcome: "created"; detail: AgentRecord }
  | {
      outcome:
        | "slug_taken"
        | "team_not_found"
        | "team_not_allowed"
        | "team_holding";
    }
  | Inactive;

/**
 * What a behavioral save was judged to be, under the agent's lock.
 * `pending`: the request differs from what the agent runs; it is stored as
 * the draft and waits for its release. `unchanged`: it equals what the agent
 * runs; any draft is cleared.
 */
export type SavedBehavior = {
  status: "pending" | "unchanged";
  versionId: string;
  /** The `behavior_revision` this save took; its release must carry it. */
  behaviorRevision: number;
};

export type UpdateAgentResult =
  | { outcome: "updated"; detail: AgentRecord; saved: SavedBehavior | null }
  // The agent changed since the values the request left out were read.
  | { outcome: "stale" }
  | { outcome: "not_found" }
  | Inactive
  | Outranked;

export type InsertReleaseResult =
  | { outcome: "created" | "exists"; release: AgentRelease }
  | { outcome: "not_found" | "github_settings_exist" }
  | Inactive
  | Outranked;

/** Why a release is made, kept on its receipts. */
export type ReleaseReason =
  | "card_saved"
  | "profile_changed"
  | "profile_rollout"
  | "profile_migration"
  | "tool_unlock"
  | "model_migration"
  | "direct";

/**
 * Who asks for an activation. A `save` carries the revision of the save it
 * finishes and clears that save's draft. A `direct` activation is a person's
 * new intent: it takes a new `behavior_revision` and leaves the draft. The
 * model source follows 2.4: it stays `profile` only if the release runs the
 * default model of its profile. A rollout changes neither the revision nor
 * the draft; under the agent's lock it is `superseded` unless the agent still
 * follows, still has the `behaviorRevision` it was judged on, and
 * `targetProfileId` is still the newest of its profile (design 2.3).
 */
export type ActivationIntent =
  | {
      kind: "save";
      behaviorRevision: number;
      draftVersionId: string;
      modelSource: ModelSource;
    }
  | {
      kind: "rollout";
      behaviorRevision: number;
      targetProfileId: string;
    }
  | {
      /**
       * A person's "bring it to the newest": judged as a rollout is, but the
       * agent need not follow yet; it follows in the same write, the draft is
       * left as it is and the agent's refused rollout items are closed.
       */
      kind: "raise";
      behaviorRevision: number;
      targetProfileId: string;
    }
  | {
      kind: "migrate";
      migrationId: string;
      /** The receipt of a revert must not be read back as a forward move. */
      revert?: boolean;
      expected: {
        activeReleaseId: string;
        activationRevision: number;
        behaviorRevision: number;
        tracking: "follow" | "pinned";
        modelSource: ModelSource;
      };
      tracking: "follow" | "pinned";
    }
  | {
      /**
       * The one-time unlock of tools the card used to narrow: the same
       * profile and card, a release computed without the card's tool fields.
       * Judged against the revisions the plan read; changes neither
       * tracking, the model source nor the draft. The rollout item is
       * written in the same transaction as the swap.
       */
      kind: "tool_unlock";
      /** Null when the profile has no stored row to hang a rollout on. */
      rolloutId: string | null;
      expected: {
        activeReleaseId: string;
        activationRevision: number;
        behaviorRevision: number;
      };
      tools: { before: string[]; after: string[] };
    }
  | {
      kind: "model_migration";
      expected: {
        activeReleaseId: string;
        activationRevision: number;
        behaviorRevision: number;
      };
      from: string;
      to: string;
    }
  | {
      kind: "direct";
      releaseRunsProfileDefault: boolean;
      /**
       * The release's profile runs differently from its lineage's newest
       * (design 2.4): the agent stops following, in the same write.
       */
      pinsProfile?: boolean;
    };

export type ActivateResult =
  | {
      outcome: "activated";
      revision: number;
      previousReleaseId: string | null;
      receiptId: string;
    }
  | { outcome: "unchanged"; revision: number; previousReleaseId: null }
  | { outcome: "conflict"; activeReleaseId: string | null; revision: number }
  // The save was replaced by a newer intent before it could activate.
  | { outcome: "superseded" }
  | { outcome: "not_found" }
  | Inactive
  | Outranked;

export interface AgentStore {
  /**
   * One page, oldest first, of the agents `reader` may read (agent.read),
   * narrowed by `q` and `ids`; a malformed cursor throws
   * InvalidCursorError. `include` is the service's.
   */
  list(
    workspaceId: string,
    query: ListAgentsQuery,
    reader: AgentReader,
  ): Promise<ListAgentsResponse>;
  /**
   * The list summary of each agent named whose settings `viewer` may read
   * (agent.settings_read), keyed by id, read for the whole page at once; any
   * other id is left out.
   */
  summaries(
    workspaceId: string,
    agentIds: readonly string[],
    viewer: SessionViewer,
  ): Promise<Map<string, AgentSummary>>;
  /** What `list` holds for `reader` read to the end, and how many of it they administer. */
  count(
    workspaceId: string,
    reader: AgentReader,
  ): Promise<CountAgentsResponse["counts"]>;
  get(workspaceId: string, agentId: string): Promise<AgentRecord | null>;
  findVersion(
    workspaceId: string,
    agentId: string,
    versionId: string,
  ): Promise<AgentVersion | null>;
  findRelease(
    workspaceId: string,
    releaseId: string,
  ): Promise<AgentRelease | null>;
  /**
   * Whether a release of the agent made after this one has ever been
   * activated: going back to this one is then a rollback.
   */
  releaseSuperseded(
    workspaceId: string,
    agentId: string,
    releaseId: string,
  ): Promise<boolean>;
  /** The agent, version 1 and their receipt in one transaction. */
  create(input: {
    principal: Principal;
    workspaceId: string;
    slug: string;
    name: string;
    description?: string;
    /**
     * `managerRoles` name any live team; anyone else only a team they are
     * in, re-read under share locks.
     */
    managingTeam: { id: string } & ManagerRoles;
    card: AgentCard;
    contentSha256: string;
    createdBy: string;
  }): Promise<CreateAgentResult>;
  /**
   * Renames, describes and/or adds a version. A card whose hash matches an
   * existing version of the agent adds nothing.
   */
  update(
    input: ManagerRoles & {
      principal: Principal;
      workspaceId: string;
      agentId: string;
      name?: string;
      /** `null` clears it. */
      description?: string | null;
      autoModelMigration?: boolean;
      card?: { card: AgentCard; contentSha256: string };
      /**
       * Makes the save a change of behavior (needs `card`): it takes a
       * `behavior_revision` and is judged against the active release.
       */
      behavior?: {
        runtimeProfileId: string;
        modelSource: ModelSource;
        /**
         * The agent as the request's omitted values were read from it:
         * `stale` when it has moved since. Absent when nothing was left out.
         */
        basedOn?: { behaviorRevision: number; activationRevision: number };
      };
      updatedBy: string;
    },
  ): Promise<UpdateAgentResult>;
  /**
   * Writes `failure` on the agent's draft, only while the agent's
   * `behavior_revision` and draft are the save's own. False: a newer save
   * took over and nothing was written.
   */
  recordDraftFailure(input: {
    workspaceId: string;
    agentId: string;
    behaviorRevision: number;
    draftVersionId: string;
    failure: string;
  }): Promise<boolean>;
  /**
   * The agent follows its profile again without a release (it already runs
   * the newest version). Under the agent's lock, as a save is.
   */
  followProfile(
    input: {
      principal: Principal;
      workspaceId: string;
      agentId: string;
      /** The activation revision the newest-version judgment was made on. */
      expectedActivationRevision: number;
    } & ManagerRoles,
  ): Promise<
    { outcome: "updated" | "superseded" | "not_found" } | Inactive | Outranked
  >;
  /**
   * Inserts the release, a `release_created` event and a receipt in one
   * transaction, or returns the row already stored under that id.
   * `not_found` when the version is not the agent's.
   */
  insertRelease(
    input: ManagerRoles & {
      principal: Principal;
      workspaceId: string;
      release: NewAgentRelease;
      /**
       * The request carried `github`: `github_settings_exist` instead of a
       * release when the agent has a settings row, judged under the lock.
       */
      refuseGitHubWhenSettings?: boolean;
      reason?: ReleaseReason;
    },
  ): Promise<InsertReleaseResult>;
  /** Whether the agent has an `agent_github_settings` row. */
  hasGitHubSettings(agentId: string): Promise<boolean>;
  modelMigrationCandidates(input: {
    after: string | null;
    limit: number;
  }): Promise<
    {
      workspaceId: string;
      agentId: string;
      profileId: string;
      model: string;
    }[]
  >;
  autoModelMigration(workspaceId: string, agentId: string): Promise<boolean>;
  notifyModelMigrationFailed(input: {
    workspaceId: string;
    agentId: string;
    from: string;
    to: string;
    reason: string;
  }): Promise<number>;
  /**
   * `UPDATE agents … WHERE activation_revision = expected`, the release's
   * first approval, an `activated` event and a receipt in one transaction.
   */
  activate(
    input: ManagerRoles & {
      principal: Principal;
      workspaceId: string;
      agentId: string;
      releaseId: string;
      expectedRevision: number;
      approvedBy: string;
      intent?: ActivationIntent;
      reason?: ReleaseReason;
    },
  ): Promise<ActivateResult>;
}
