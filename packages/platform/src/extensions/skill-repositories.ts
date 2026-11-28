import {
  type CheckSkillRepositoryResponse,
  type PutSkillRepositoryRefResponse,
  type PutSkillRepositorySkillSwitchResponse,
  type RegisterSkillRepositoryRequest,
  type RegisterSkillRepositoryResponse,
  type RemoveSkillRepositoryResponse,
  SKILL_REPOSITORY_URL,
  type SkillRepositoryDetail,
  type SkillRepositoryList,
  type SkillRepositorySkillView,
  type SkillRepositoryView,
} from "@werft-ai/contracts";
import type { GitHubAppCredential } from "../github/ports/github-app-store.ts";
import { GitHubAppCheckError } from "../github/ports/github-app-store.ts";
import {
  ACTOR_INACTIVE,
  type AuthorizationPolicy,
  type Caller,
  NOT_FOUND,
  OUTRANKED,
  requirePermitted,
  SessionServiceError,
} from "../musterrolle/index.ts";
import {
  type createExtensionBundleService,
  EXTENSION_MANAGER_ROLES,
} from "./bundle-service.ts";
import type { BundleIssue } from "./bundle-validator.ts";
import type {
  SkillSyncIssue,
  SkillSyncTrigger,
} from "./ports/skill-git-source-store.ts";
import type {
  SkillGateFindingRecord,
  SkillRepository,
  SkillRepositoryRead,
  SkillRepositorySkill,
  SkillRepositorySkillCheck,
  SkillRepositoryStore,
  SkillRepositorySync,
  SkillRepositoryTrigger,
} from "./ports/skill-repository-store.ts";
import {
  type GitHubSkillReader,
  type GitHubSkillRepository,
  type GitHubSkillTree,
  publicReadingInstallation,
  SKILL_CHECK_LEASE_MS,
  SKILL_DAILY_CLAIM_MS,
  SKILL_DAILY_INTERVAL_MS,
} from "./skill-git-sync.ts";
import { refused, skillManager, unavailable } from "./skill-manage.ts";
import {
  listSkillRepository,
  repositoryRootFiles,
  storable,
} from "./skill-repository-listing.ts";

// Skill repositories: an owner or admin registers a public GitHub repository
// by its address, and that registration is the approval. Its SKILL.md
// directories are listed, each switched off. Registering, "지금 확인", a ref
// change and the daily pass all read the listing the same way, and then
// check the skills switched on: each one's files are read, judged by the
// gate, and stored as its current version only when they pass.

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
  /** Registers a switched-on skill's content as a version once its gate passes it. */
  bundles: Pick<ReturnType<typeof createExtensionBundleService>, "register">;
  /** A check that failed outside GitHub, or a gate with no answer; never a secret or file content. */
  failed?: (error: unknown, fields: Record<string, unknown>) => void;
  now?: () => Date;
  /** How long a listing holds its repository; a replica that died lets go then. */
  leaseMs?: number;
  newId?: () => string;
};

/** How many repositories one daily pass checks, one after another. */
const DAILY_BATCH = 10;

type Listing =
  | {
      kind: "listed";
      github: GitHubSkillRepository;
      read: SkillRepositoryRead;
      /** File names at the repository's root, which the gate reads for a notice. */
      rootFiles: string[];
    }
  | { kind: "unavailable"; commit: string | null; error: unknown }
  /** The ref names no commit, or the repository is gone or no longer public. */
  | { kind: "missing"; commit: string | null; what: "ref" | "repository" }
  | { kind: "refused"; commit: string; issues: SkillSyncIssue[] };

/** The trigger a version, and the skill's own source row, keep of a repository's check. */
function skillTrigger(
  trigger: SkillRepositoryTrigger,
  first: boolean,
): SkillSyncTrigger {
  return {
    kind:
      trigger.kind === "daily"
        ? "daily"
        : trigger.kind === "enable"
          ? first
            ? "register"
            : "resume"
          : "manual",
    deliveryId: null,
    userId: trigger.userId,
  };
}

const MAX_ISSUES = 20;

/** The checker's issues by their path inside the skill. */
function bundleIssues(root: string, issues: BundleIssue[]): SkillSyncIssue[] {
  return issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: storable(
      issue.path.startsWith(root) ? issue.path.slice(root.length) : issue.path,
    ),
    code: issue.code,
    message: storable(issue.message),
  }));
}

/**
 * What the skill's own source row keeps of a check that wrote no version: a
 * host from before repositories reads that row, so only results it knows.
 * The gate's refusal reads there as the checker's.
 */
function sourceCheckOf(
  result: SkillRepositorySkillCheck["result"],
  issues: SkillSyncIssue[],
  blocks: SkillGateFindingRecord[],
  trigger: SkillSyncTrigger,
  name: string | null,
): Parameters<SkillRepositoryStore["recordSkillCheck"]>[0]["sourceCheck"] {
  switch (result) {
    case "rejected":
      return { trigger, result, issues };
    case "blocked": {
      const root = name === null ? "" : `skills/${name}/`;
      return {
        trigger,
        result: "rejected",
        issues: blocks
          .flatMap((block) =>
            block.paths.map((path) => ({
              path: path.startsWith(root) ? path.slice(root.length) : path,
              code: block.rule,
              message: "The repository's automatic check refused this file.",
            })),
          )
          .slice(0, MAX_ISSUES),
      };
    }
    case "source_missing":
    case "github_unavailable":
      return { trigger, result, issues: [] };
    default:
      return null;
  }
}

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

function checkView(
  check: SkillRepositorySkillCheck,
): NonNullable<SkillRepositorySkillView["last_check"]> {
  return {
    at: check.at.toISOString(),
    trigger: { kind: check.trigger.kind, user_id: check.trigger.userId },
    commit: check.commit,
    result: check.result,
    version_id: check.versionId,
    issues: check.issues,
    blocks: check.blocks,
    warnings: check.warnings,
    notices: check.notices,
  };
}

/**
 * Off: what would keep it from being switched on, if anything. On: whether
 * it has a version agents can be given, whatever its last check said (a
 * held-back update leaves the version before it in place).
 */
function statusOf(
  skill: SkillRepositorySkill,
): SkillRepositorySkillView["status"] {
  if (skill.enabled) {
    if (skill.currentVersionId !== null) return "on";
    return skill.lastCheck === null ? "checking" : "failed";
  }
  if (skill.issues.length > 0) return "unavailable";
  // Its own skill holds its name; anyone else's is a conflict.
  return skill.nameOwner !== null && skill.skillName !== skill.name
    ? "conflict"
    : "off";
}

function skillView(skill: SkillRepositorySkill): SkillRepositorySkillView {
  return {
    id: skill.id,
    path: skill.path,
    name: skill.name,
    description: skill.description,
    license: skill.license,
    status: statusOf(skill),
    issues: skill.issues,
    name_owner: skill.nameOwner,
    name_shared: skill.nameShared,
    present: skill.present,
    enabled: skill.enabled,
    current_version_id: skill.currentVersionId,
    last_check: skill.lastCheck === null ? null : checkView(skill.lastCheck),
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
        rootFiles: repositoryRootFiles(tree),
      };
    } catch (error) {
      if (!(error instanceof GitHubAppCheckError)) throw error;
      return { kind: "unavailable", commit, error };
    }
  }

  /**
   * Checks one switched-on skill at the commit a listing read: its files, the
   * checker, the gate, and its next version when they pass. What it found is
   * kept on the skill. False when the repository was no longer this check's
   * to write.
   */
  async function checkSkill(input: {
    repository: SkillRepository;
    skill: SkillRepositorySkill & { grantId: string };
    app: AppKey;
    commit: string;
    rootFiles: string[];
    trigger: SkillRepositoryTrigger;
    token: string;
    at: Date;
  }): Promise<boolean> {
    const { repository, skill, app, commit, trigger, token, at } = input;
    const workspaceId = repository.workspaceId;
    // The name its first version took; a directory with none yet takes the
    // one its SKILL.md names now.
    const name = skill.skillName ?? skill.name;
    const versionTrigger = skillTrigger(trigger, skill.skillName === null);
    const record = (
      result: SkillRepositorySkillCheck["result"],
      found: {
        issues?: SkillSyncIssue[];
        blocks?: SkillGateFindingRecord[];
      } = {},
    ) => {
      const issues = found.issues ?? [];
      const blocks = found.blocks ?? [];
      return store.recordSkillCheck({
        workspaceId,
        id: repository.id,
        skillId: skill.id,
        token,
        generation: repository.generation,
        grantId: skill.grantId,
        check: {
          at,
          trigger,
          commit,
          result,
          versionId: null,
          issues,
          blocks,
          warnings: [],
          notices: [],
        },
        sourceCheck: sourceCheckOf(
          result,
          issues,
          blocks,
          versionTrigger,
          name,
        ),
      });
    };
    if (!skill.present) return record("source_missing");
    if (name === null) return record("rejected", { issues: skill.issues });
    let tree: GitHubSkillTree;
    try {
      tree = await reader.read(
        app,
        repository.installationId,
        repository.repositoryId,
        commit,
        skill.path,
      );
      if (tree.kind === "files") {
        // Asked again after the files, as a listing does: what was read from
        // a repository that turned private, or changed hands, is not stored.
        const github = await reader.repositoryById(
          app,
          repository.installationId,
          repository.repositoryId,
        );
        if (github?.public !== true) return record("source_missing");
        // The repository's next check says so, and stops there.
        if (github.ownerId !== repository.ownerId) return true;
      }
    } catch (error) {
      if (!(error instanceof GitHubAppCheckError)) throw error;
      return record("github_unavailable");
    }
    if (tree.kind === "missing") return record("source_missing");
    if (tree.kind === "refused") {
      return record("rejected", { issues: tree.issues });
    }
    const root = `skills/${name}/`;
    const result = await deps.bundles.register({
      principal: { ownerId: workspaceId },
      slug: name,
      files: tree.files.map((file) => ({
        ...file,
        path: `${root}${file.path}`,
      })),
      label: name,
      source: "github",
      skill: true,
      git: {
        location: {
          repositoryId: repository.repositoryId,
          path: skill.path,
          ref: repository.ref,
          commit,
        },
        trigger: versionTrigger,
        checkedAt: at,
        repository: {
          skillRepositoryId: repository.id,
          skillId: skill.id,
          generation: repository.generation,
          leaseToken: token,
          grantId: skill.grantId,
          trigger,
          treeSha: skill.treeSha,
          rootFiles: input.rootFiles,
        },
      },
    });
    switch (result.outcome) {
      // Kept on the skill by the version's own write.
      case "registered":
      case "already_registered":
      case "withheld":
      case "baseline_changed":
      case "name_conflict":
      // The repository or the switch changed under the check: nothing of it
      // is written, and nothing is this check's to say.
      case "stale":
        return true;
      case "lease_lost":
        return false;
      case "rejected":
        return record("rejected", {
          issues: bundleIssues(root, result.issues),
        });
      case "blocked":
        return record("blocked", { blocks: result.blocks });
      case "gate_unavailable":
        deps.failed?.(new Error("the gate gave no answer"), {
          workspace_id: workspaceId,
          skill_repository_id: repository.id,
          skill: name,
          // Which step, and why: "gate timeout", "secret scan busy".
          detail: result.detail,
        });
        return record("gate_unavailable");
      default:
        throw new Error(
          `a repository skill's check reached the ${result.outcome} path`,
        );
    }
  }

  /**
   * One check of a repository: its listing, then every skill switched on
   * (`only`: that one). Records what it read; throws only off GitHub. False
   * when another check had taken the repository over before this one had
   * written everything.
   */
  async function once(
    workspaceId: string,
    id: string,
    trigger: SkillRepositoryTrigger,
    token: string,
    only: string | null,
  ): Promise<boolean> {
    // Read again each run: a ref change kept as a trigger runs at the new ref.
    const repository = await store.find(workspaceId, id);
    if (repository === null || repository.removedAt !== null) return true;
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
        token,
        generation: repository.generation,
        sync: { at, trigger, commit, result, issues },
        read,
      });
    const app = (await deps.apps(workspaceId)).find(
      (one) => one.id === repository.connectionId,
    );
    if (app === undefined) return record("github_unavailable", null);
    const listing = await listingOf(
      app,
      repository.installationId,
      repository.repositoryId,
      repository.ref,
    );
    switch (listing.kind) {
      case "unavailable":
        return record("github_unavailable", listing.commit);
      case "missing":
        return record("source_missing", listing.commit);
      case "refused":
        return record("rejected", listing.commit, listing.issues);
    }
    // Registering approved what that owner publishes. Under another owner
    // nothing more is taken: not the listing, and no skill's files. The
    // versions the skills have stay.
    if (listing.github.ownerId !== repository.ownerId) {
      return record("owner_changed", listing.read.commit);
    }
    if (!(await record("listed", listing.read.commit, [], listing.read))) {
      return false;
    }
    let held = true;
    let failure: { error: unknown } | null = null;
    for (const skill of await store.skills(workspaceId, id)) {
      const { grantId } = skill;
      if (!skill.enabled || grantId === null) continue;
      if (only !== null && skill.id !== only) continue;
      // Each skill gets the whole lease: many take longer than one.
      if (!(await store.extend(workspaceId, id, leaseMs, token))) return false;
      try {
        const kept = await checkSkill({
          repository,
          skill: { ...skill, grantId },
          app,
          commit: listing.read.commit,
          rootFiles: listing.rootFiles,
          trigger,
          token,
          at,
        });
        if (!kept) held = false;
      } catch (error) {
        // One skill failing off GitHub leaves the others their check.
        failure ??= { error };
      }
    }
    if (failure !== null) throw failure.error;
    return held;
  }

  /**
   * Runs the check of one repository, or leaves the trigger for the check
   * that holds it. The holder runs once more for what arrived meanwhile.
   * `lease_lost`, never `checked`, for a check another one took over.
   */
  async function check(
    workspaceId: string,
    id: string,
    trigger: SkillRepositoryTrigger,
    only: string | null = null,
  ): Promise<"checked" | "queued" | "not_found" | "lease_lost"> {
    const begun = await store.begin(workspaceId, id, trigger, leaseMs);
    if (begun.outcome !== "started") return begun.outcome;
    const token = begun.token;
    let next: SkillRepositoryTrigger | null = trigger;
    let scope = only;
    let held = true;
    let failure: { error: unknown } | null = null;
    try {
      while (next !== null) {
        // A run that fails still lets a trigger kept meanwhile run.
        try {
          if (!(await once(workspaceId, id, next, token, scope))) held = false;
        } catch (error) {
          failure ??= { error };
        }
        // What was kept meanwhile checks every skill, whichever it was for.
        scope = null;
        next = await store.finish(workspaceId, id, leaseMs, token);
      }
    } catch (error) {
      // The store failed: let go; the lease would once it passes.
      await store.finish(workspaceId, id, 0, token).catch(() => undefined);
      throw error;
    }
    if (failure !== null) throw failure.error;
    return held ? "checked" : "lease_lost";
  }

  return {
    check,

    /** Checks the repositories whose last check is a day old; returns how many. */
    async daily(): Promise<number> {
      const due = await store.due(
        new Date(now().getTime() - SKILL_DAILY_INTERVAL_MS),
        DAILY_BATCH,
        SKILL_DAILY_CLAIM_MS,
      );
      for (const { workspaceId, id } of due) {
        await check(workspaceId, id, { kind: "daily", userId: null }).catch(
          (error) =>
            deps.failed?.(error, {
              workspace_id: workspaceId,
              skill_repository_id: id,
            }),
        );
      }
      return due.length;
    },

    /**
     * Turns a skill's switch on or off. On, its content is checked at once:
     * the answer carries what the check found. Off, the skill is hidden from
     * new sessions; its versions stay for the sessions that run them.
     */
    async setSwitch(
      caller: Caller,
      id: string,
      skillId: string,
      enabled: boolean,
    ): Promise<PutSkillRepositorySkillSwitchResponse> {
      const userId = await manager(caller);
      const result = await store.setSwitch({
        workspaceId: caller.ownerId,
        id,
        skillId,
        enabled,
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
        case "removed":
          throw refused(
            "repository_removed",
            "The repository is removed; register it again to bring it back",
          );
        case "unavailable":
          throw refused(
            "skill_listing_refused",
            "The listing check refuses this directory; its issues say why",
          );
        case "missing":
          throw refused(
            "skill_missing",
            "The directory is gone from the repository",
          );
        case "name_conflict":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            "Another skill of the workspace holds this name; the one that had a version first keeps it",
            undefined,
            { reason_code: "skill_name_conflict", name_owner: result.owner },
          );
        case "unchanged":
        case "updated": {
          const ran =
            result.outcome === "updated" && enabled
              ? await check(
                  caller.ownerId,
                  id,
                  { kind: "enable", userId },
                  skillId,
                )
              : null;
          const repository = await store.find(caller.ownerId, id);
          if (repository === null) throw NOT_FOUND();
          return {
            ...(await detail(repository)),
            receipt_id: result.outcome === "updated" ? result.receiptId : null,
            check: ran === "not_found" ? null : ran,
          };
        }
      }
    },

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
