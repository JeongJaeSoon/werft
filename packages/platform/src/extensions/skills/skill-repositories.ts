import {
  type CheckSkillRepositoryResponse,
  type PutSkillRepositoryRefResponse,
  type RegisterSkillRepositoryRequest,
  type RegisterSkillRepositoryResponse,
  type RemoveSkillRepositoryResponse,
  SKILL_REPOSITORY_URL,
  type SkillRepositoryDetail,
  type SkillRepositoryList,
  type SkillRepositorySkillView,
  type SkillRepositoryView,
} from "@werft-ai/contracts";
import {
  ACTOR_INACTIVE,
  type AuthorizationPolicy,
  type Caller,
  NOT_FOUND,
  OUTRANKED,
  requirePermitted,
  SessionServiceError,
} from "../../access-control/index.ts";
import type { GitHubAppCredential } from "../../github/ports/github-app-store.ts";
import { GitHubAppCheckError } from "../../github/ports/github-app-store.ts";
import { EXTENSION_MANAGER_ROLES } from "../bundles/bundle-service.ts";
import type { SkillSyncIssue } from "../ports/skill-git-source-store.ts";
import type {
  SkillRepository,
  SkillRepositoryRead,
  SkillRepositorySkill,
  SkillRepositoryStore,
  SkillRepositorySync,
  SkillRepositoryTrigger,
} from "../ports/skill-repository-store.ts";
import {
  type GitHubSkillReader,
  type GitHubSkillRepository,
  publicReadingInstallation,
  SKILL_CHECK_LEASE_MS,
} from "./skill-git-sync.ts";
import { refused, skillManager, unavailable } from "./skill-manage.ts";
import { listSkillRepository } from "./skill-repository-listing.ts";

// Skill repositories: an owner or admin registers a public GitHub repository
// by its address, and that registration is the approval. Its SKILL.md
// directories are listed, each switched off. Registering, "지금 확인" and a
// ref change all read the listing the same way; nothing here turns a skill
// on, so no version is made.

type AppKey = Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">;

export type SkillRepositoryServiceDeps = {
  authorization: AuthorizationPolicy;
  store: SkillRepositoryStore;
  reader: GitHubSkillReader;
  /** The workspace's author App connections, with their keys. */
  apps: (workspaceId: string) => Promise<GitHubAppCredential[]>;
  /** Every installation of an App; one of them reads public repositories. */
  installations: (
    app: AppKey,
  ) => Promise<Array<{ id: number; suspendedAt: Date | null }>>;
  now?: () => Date;
  /** How long a listing holds its repository; a replica that died lets go then. */
  leaseMs?: number;
  newId?: () => string;
};

type Listing =
  | { kind: "listed"; github: GitHubSkillRepository; read: SkillRepositoryRead }
  | { kind: "unavailable"; commit: string | null; error: unknown }
  /** The ref names no commit, or the repository is gone or no longer public. */
  | { kind: "missing"; commit: string | null; what: "ref" | "repository" }
  | { kind: "refused"; commit: string; issues: SkillSyncIssue[] };

export function skillRepositoryView(
  repository: SkillRepository,
): SkillRepositoryView {
  const sync = repository.lastSync;
  return {
    id: repository.id,
    repository_id: repository.repositoryId,
    repository: repository.repository,
    ref: repository.ref,
    access: repository.access,
    connection_id: repository.connectionId,
    installation_id: repository.installationId,
    owner_id: repository.ownerId,
    license: repository.license,
    state: repository.removedAt === null ? "active" : "removed",
    last_commit: repository.lastCommit,
    last_sync:
      sync === null
        ? null
        : {
            at: sync.at.toISOString(),
            trigger: { kind: sync.trigger.kind, user_id: sync.trigger.userId },
            commit: sync.commit,
            result: sync.result,
            issues: sync.issues,
          },
    skill_count: repository.skillCount,
    created_by: repository.createdBy,
    created_at: repository.createdAt.toISOString(),
    removed_by: repository.removedBy,
    removed_at: repository.removedAt?.toISOString() ?? null,
  };
}

function skillView(skill: SkillRepositorySkill): SkillRepositorySkillView {
  return {
    id: skill.id,
    path: skill.path,
    name: skill.name,
    description: skill.description,
    license: skill.license,
    status:
      skill.issues.length > 0
        ? "unavailable"
        : skill.nameOwner !== null
          ? "conflict"
          : "off",
    issues: skill.issues,
    name_owner: skill.nameOwner,
    name_shared: skill.nameShared,
    present: skill.present,
    enabled: skill.enabled,
    tree_sha: skill.treeSha,
    file_count: skill.fileCount,
    size_bytes: skill.totalBytes,
    has_scripts: skill.hasScripts,
  };
}

export function createSkillRepositoryService(deps: SkillRepositoryServiceDeps) {
  const { store, reader, authorization } = deps;
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? SKILL_CHECK_LEASE_MS;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const manager = (caller: Caller) => skillManager(authorization, caller);
  const reads = (caller: Caller) =>
    requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });

  async function detail(
    repository: SkillRepository,
  ): Promise<SkillRepositoryDetail> {
    return {
      repository: skillRepositoryView(repository),
      skills: (await store.skills(repository.workspaceId, repository.id)).map(
        skillView,
      ),
    };
  }

  /** The repository a change is made to: there, and not removed. */
  async function active(caller: Caller, id: string): Promise<SkillRepository> {
    const repository = await store.find(caller.ownerId, id);
    if (repository === null) throw NOT_FOUND();
    if (repository.removedAt !== null) {
      throw refused(
        "repository_removed",
        "The repository is removed; register it again to bring it back",
      );
    }
    return repository;
  }

  /**
   * The ref's commit, its whole tree and its SKILL.md files, read once.
   * GitHub is asked whether the repository is public before the files and
   * again after them: one that turned private is not read through the public
   * path, even where the installation covers it.
   */
  async function listingOf(
    app: AppKey,
    installationId: number,
    repositoryId: number,
    ref: string,
  ): Promise<Listing> {
    let commit: string | null = null;
    const publicNow = async () => {
      const github = await reader.repositoryById(
        app,
        installationId,
        repositoryId,
      );
      return github?.public === true ? github : null;
    };
    try {
      if ((await publicNow()) === null) {
        return { kind: "missing", commit, what: "repository" };
      }
      commit = await reader.resolve(app, installationId, repositoryId, ref);
      if (commit === null) return { kind: "missing", commit, what: "ref" };
      const tree = await reader.tree(app, installationId, repositoryId, commit);
      if (tree === null) return { kind: "missing", commit, what: "ref" };
      const listing = await listSkillRepository(tree, (shas) =>
        reader.blobs(app, installationId, repositoryId, shas),
      );
      const github = await publicNow();
      if (github === null) {
        return { kind: "missing", commit, what: "repository" };
      }
      if (listing.kind === "refused") {
        return { kind: "refused", commit, issues: listing.issues };
      }
      return {
        kind: "listed",
        github,
        read: { commit, license: github.license, entries: listing.entries },
      };
    } catch (error) {
      if (!(error instanceof GitHubAppCheckError)) throw error;
      return { kind: "unavailable", commit, error };
    }
  }

  /** One listing; records its outcome, throws only off GitHub. */
  async function once(
    workspaceId: string,
    id: string,
    trigger: SkillRepositoryTrigger,
    lease: string,
  ): Promise<void> {
    // Read again each run: a ref change kept as a trigger runs at the new ref.
    const repository = await store.find(workspaceId, id);
    if (repository === null || repository.removedAt !== null) return;
    const at = now();
    const record = (
      result: SkillRepositorySync["result"],
      commit: string | null,
      issues: SkillSyncIssue[] = [],
      read: SkillRepositoryRead | null = null,
    ) =>
      store.record({
        workspaceId,
        id,
        token: lease,
        generation: repository.generation,
        sync: { at, trigger, commit, result, issues },
        read,
      });
    const app = (await deps.apps(workspaceId)).find(
      (one) => one.id === repository.connectionId,
    );
    if (app === undefined) {
      await record("github_unavailable", null);
      return;
    }
    const listing = await listingOf(
      app,
      repository.installationId,
      repository.repositoryId,
      repository.ref,
    );
    switch (listing.kind) {
      case "unavailable":
        await record("github_unavailable", listing.commit);
        return;
      case "missing":
        await record("source_missing", listing.commit);
        return;
      case "refused":
        await record("rejected", listing.commit, listing.issues);
        return;
      case "listed":
        await record("listed", listing.read.commit, [], listing.read);
    }
  }

  /**
   * Runs the listing of one repository, or leaves the trigger for the
   * listing that holds it. The holder runs once more for what arrived
   * meanwhile.
   */
  async function check(
    workspaceId: string,
    id: string,
    trigger: SkillRepositoryTrigger,
  ): Promise<"checked" | "queued" | "not_found"> {
    const begun = await store.begin(workspaceId, id, trigger, leaseMs);
    if (begun.outcome !== "started") return begun.outcome;
    const lease = begun.token;
    let next: SkillRepositoryTrigger | null = trigger;
    let failure: { error: unknown } | null = null;
    try {
      while (next !== null) {
        // A run that fails still lets a trigger kept meanwhile run.
        try {
          await once(workspaceId, id, next, lease);
        } catch (error) {
          failure ??= { error };
        }
        next = await store.finish(workspaceId, id, leaseMs, lease);
      }
    } catch (error) {
      // The store failed: let go; the lease would once it passes.
      await store.finish(workspaceId, id, 0, lease).catch(() => undefined);
      throw error;
    }
    if (failure !== null) throw failure.error;
    return "checked";
  }

  return {
    check,

    /** Every repository the workspace registered, removed ones too. */
    async list(caller: Caller): Promise<SkillRepositoryList> {
      await reads(caller);
      return {
        items: (await store.list(caller.ownerId)).map(skillRepositoryView),
      };
    },

    async get(caller: Caller, id: string): Promise<SkillRepositoryDetail> {
      await reads(caller);
      const repository = await store.find(caller.ownerId, id);
      if (repository === null) throw NOT_FOUND();
      return detail(repository);
    },

    /**
     * Registers the repository at `url`, which approves it: its listing is
     * read and written with the row. A removed row of the same GitHub
     * repository is brought back instead.
     */
    async register(
      caller: Caller,
      request: RegisterSkillRepositoryRequest,
    ): Promise<RegisterSkillRepositoryResponse> {
      await manager(caller);
      const [, owner = "", name = ""] =
        SKILL_REPOSITORY_URL.exec(request.url) ?? [];
      let reading: { app: GitHubAppCredential; installationId: number } | null =
        null;
      let github: GitHubSkillRepository | null = null;
      try {
        // The oldest author connection with an installation to read with.
        for (const app of await deps.apps(caller.ownerId)) {
          const installation = publicReadingInstallation(
            await deps.installations(app),
          );
          if (installation !== null) {
            reading = { app, installationId: installation.id };
            break;
          }
        }
        if (reading !== null) {
          github = await reader.repository(
            reading.app,
            reading.installationId,
            owner,
            name,
          );
        }
      } catch (error) {
        if (!(error instanceof GitHubAppCheckError)) throw error;
        throw unavailable(error);
      }
      if (reading === null) {
        throw refused(
          "no_installation",
          "No author App of the workspace has an installation to read GitHub with",
        );
      }
      if (github === null) {
        throw refused(
          "repository_not_found",
          "GitHub shows no public repository at that address",
        );
      }
      const notPublic = () =>
        refused(
          "repository_not_public",
          "Only a public repository can be registered",
        );
      if (!github.public) throw notPublic();
      const ref = request.ref ?? github.defaultBranch;
      const listing = await listingOf(
        reading.app,
        reading.installationId,
        github.id,
        ref,
      );
      switch (listing.kind) {
        case "unavailable":
          throw unavailable(listing.error);
        case "missing":
          throw listing.what === "ref"
            ? refused("ref_not_found", "The ref names no commit")
            : notPublic();
        case "refused":
          throw refused(
            "listing_refused",
            "The repository is past what a listing reads",
            { issues: listing.issues },
          );
      }
      const result = await store.register({
        workspaceId: caller.ownerId,
        id: newId(),
        receiptId: newId(),
        principal: caller,
        managerRoles: EXTENSION_MANAGER_ROLES,
        url: request.url,
        github: {
          repositoryId: listing.github.id,
          repository: listing.github.fullName,
          ownerId: listing.github.ownerId,
        },
        ref,
        connectionId: reading.app.id,
        installationId: reading.installationId,
        read: listing.read,
        at: now(),
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "already_registered":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            "The workspace already follows that repository; change its ref instead",
            undefined,
            {
              reason_code: "repository_already_registered",
              skill_repository_id: result.repository.id,
            },
          );
        case "registered":
        case "restored":
          return {
            outcome: result.outcome,
            ...(await detail(result.repository)),
            receipt_id: result.receiptId,
          };
      }
    },

    /** Removes the repository: its skills are withdrawn, nothing is deleted. */
    async remove(
      caller: Caller,
      id: string,
    ): Promise<RemoveSkillRepositoryResponse> {
      await manager(caller);
      const result = await store.remove({
        workspaceId: caller.ownerId,
        id,
        receiptId: newId(),
        principal: caller,
        managerRoles: EXTENSION_MANAGER_ROLES,
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "unchanged":
          return {
            repository: skillRepositoryView(result.repository),
            receipt_id: null,
          };
        case "removed":
          return {
            repository: skillRepositoryView(result.repository),
            receipt_id: result.receiptId,
          };
      }
    },

    /** "지금 확인": reads the listing again, and waits for it. */
    async checkNow(
      caller: Caller,
      id: string,
    ): Promise<CheckSkillRepositoryResponse> {
      const userId = await manager(caller);
      await active(caller, id);
      const outcome = await check(caller.ownerId, id, {
        kind: "manual",
        userId,
      });
      const repository = await store.find(caller.ownerId, id);
      if (outcome === "not_found" || repository === null) throw NOT_FOUND();
      return { outcome, ...(await detail(repository)) };
    },

    /**
     * Points the repository at another ref, once GitHub resolves it to a
     * commit, and reads the listing there.
     */
    async setRef(
      caller: Caller,
      id: string,
      ref: string,
    ): Promise<PutSkillRepositoryRefResponse> {
      const userId = await manager(caller);
      const before = await active(caller, id);
      // Nothing to follow, and nothing written: every ref the store takes
      // below is one this call resolved.
      if (before.ref === ref) {
        return { ...(await detail(before)), receipt_id: null, check: null };
      }
      const app = (await deps.apps(caller.ownerId)).find(
        (one) => one.id === before.connectionId,
      );
      if (app === undefined) {
        throw unavailable(new GitHubAppCheckError("github_rejected"));
      }
      let github: GitHubSkillRepository | null;
      let commit: string | null = null;
      try {
        github = await reader.repositoryById(
          app,
          before.installationId,
          before.repositoryId,
        );
        if (github?.public === true) {
          commit = await reader.resolve(
            app,
            before.installationId,
            before.repositoryId,
            ref,
          );
        }
      } catch (error) {
        if (!(error instanceof GitHubAppCheckError)) throw error;
        throw unavailable(error);
      }
      if (github?.public !== true) {
        throw refused(
          "repository_not_public",
          "The repository is no longer public",
        );
      }
      if (commit === null) {
        throw refused("ref_not_found", "The ref names no commit");
      }
      const result = await store.setRef({
        workspaceId: caller.ownerId,
        id,
        ref,
        generation: before.generation,
        receiptId: newId(),
        principal: caller,
        managerRoles: EXTENSION_MANAGER_ROLES,
      });
      switch (result.outcome) {
        case "changed":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "The repository changed while its ref was checked; send the change again",
            undefined,
            { reason_code: "repository_changed" },
          );
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "unchanged":
          return {
            ...(await detail(result.repository)),
            receipt_id: null,
            check: null,
          };
        case "updated": {
          const ran = await check(caller.ownerId, id, { kind: "ref", userId });
          const repository =
            (await store.find(caller.ownerId, id)) ?? result.repository;
          return {
            ...(await detail(repository)),
            receipt_id: result.receiptId,
            check: ran === "not_found" ? null : ran,
          };
        }
      }
    },
  };
}

export type SkillRepositoryService = ReturnType<
  typeof createSkillRepositoryService
>;
