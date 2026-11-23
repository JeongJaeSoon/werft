import type {
  CheckSkillResponse,
  RegisterGitHubSkillRequest,
  RegisterSkillResponse,
  SkillSyncResponse,
} from "@werft-ai/contracts";
import { githubSignatureMatches } from "../github/index.ts";
import type { GitHubAppCredential } from "../github/ports/github-app-store.ts";
import {
  GitHubAppCheckError,
  githubUnavailableOf,
} from "../github/ports/github-app-store.ts";
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
import type { BundleInputFile, BundleIssue } from "./bundle-validator.ts";
import type {
  SkillGitSource,
  SkillGitSourceStore,
  SkillSyncCheck,
  SkillSyncIssue,
  SkillSyncTrigger,
} from "./ports/skill-git-source-store.ts";
import { skillVersionViewOf } from "./skill-service.ts";

// Git skills: a push
// webhook, a daily check and "지금 확인" all run one check. It resolves the
// ref through the API again, never trusting a webhook body for the commit
// or the content, reads the tree at that commit and registers it as the
// next `pending` version only when its digest is new.

type AppKey = Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">;

/** A skill directory read at one commit, as the reader found it. */
export type GitHubSkillTree =
  | { kind: "files"; files: BundleInputFile[] }
  /** The path is not a directory at that commit. */
  | { kind: "missing" }
  /** Refused before its contents were fetched (size, count, a submodule). */
  | { kind: "refused"; issues: SkillSyncIssue[] };

/** GitHub as one installation's token reads it. Throws GitHubAppCheckError. */
export interface GitHubSkillReader {
  /** `owner/name`, or null when the installation's token cannot read it. */
  repository(
    app: AppKey,
    installationId: number,
    owner: string,
    name: string,
  ): Promise<{ id: number; fullName: string } | null>;
  /** The commit `ref` names now (by repository id); null when none. */
  resolve(
    app: AppKey,
    installationId: number,
    repositoryId: number,
    ref: string,
  ): Promise<string | null>;
  /** The files under `path` at `commit`, paths relative to `path`. */
  read(
    app: AppKey,
    installationId: number,
    repositoryId: number,
    commit: string,
    path: string,
  ): Promise<GitHubSkillTree>;
  /** Whether `ref` names a branch, and not a tag or a commit. */
  isBranch(
    app: AppKey,
    installationId: number,
    repositoryId: number,
    ref: string,
  ): Promise<boolean>;
}

/** A connection that may receive webhooks, with its stored secret. */
export type GitHubWebhookSecret = {
  workspaceId: string;
  connectionId: string;
  secret: string;
};

export type SkillGitSyncDeps = {
  authorization: AuthorizationPolicy;
  sources: SkillGitSourceStore;
  bundles: ReturnType<typeof createExtensionBundleService>;
  reader: GitHubSkillReader;
  /** The workspace's author App connections, with their keys. */
  apps: (workspaceId: string) => Promise<GitHubAppCredential[]>;
  /** Which installation of the App covers `owner/name`; null when none. */
  installationFor: (
    app: AppKey,
    repo: { owner: string; name: string },
  ) => Promise<{ id: number } | null>;
  /** The connections of App `appId` with a webhook secret stored. */
  webhookSecrets: (appId: number) => Promise<GitHubWebhookSecret[]>;
  now?: () => Date;
  /** How long a check holds its skill; a replica that died lets go then. */
  leaseMs?: number;
  /** A check that failed outside GitHub; never a secret or file content. */
  failed?: (error: unknown, fields: Record<string, unknown>) => void;
  newId?: () => string;
};

export const SKILL_CHECK_LEASE_MS = 5 * 60_000;
export const SKILL_DAILY_INTERVAL_MS = 24 * 60 * 60_000;
/** How often a replica looks for sources whose day has passed. */
export const SKILL_DAILY_CHECK_PASS_MS = 10 * 60_000;
/**
 * How long the daily pass's claim on a source lasts: a replica that died
 * before checking it lets it go then. Longer than a batch takes.
 */
export const SKILL_DAILY_CLAIM_MS = 30 * 60_000;
const DAILY_BATCH = 50;

const refused = (reasonCode: string, message: string, details = {}) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code: reasonCode,
    ...details,
  });

const unavailable = (error: unknown) =>
  new SessionServiceError(
    "GITHUB_UNAVAILABLE",
    "GitHub could not be read with the workspace's App",
    undefined,
    { reason_code: githubUnavailableOf(error) },
  );

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

/** The three things a push body is read for; nothing else in it is used. */
function pushTarget(body: Uint8Array) {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const push = (json ?? {}) as {
    ref?: unknown;
    repository?: { id?: unknown };
    installation?: { id?: unknown };
  };
  const installationId = asNumber(push.installation?.id);
  const repositoryId = asNumber(push.repository?.id);
  if (
    installationId === null ||
    repositoryId === null ||
    typeof push.ref !== "string"
  ) {
    return null;
  }
  return { installationId, repositoryId, ref: push.ref };
}

export function skillGitSourceView(
  source: SkillGitSource,
  webhook: "ready" | "no_public_url" | "no_secret",
) {
  const check = source.lastCheck;
  return {
    connection_id: source.connectionId,
    installation_id: source.installationId,
    repository_id: source.repositoryId,
    repository: source.repository,
    path: source.path,
    ref: source.ref,
    sync_enabled: source.syncEnabled,
    webhook,
    auto_approve: {
      state: source.autoApprove.state,
      enabled_by: source.autoApprove.enabledBy,
    },
    last_check:
      check === null
        ? null
        : {
            at: check.at.toISOString(),
            trigger: {
              kind: check.trigger.kind,
              delivery_id: check.trigger.deliveryId,
              user_id: check.trigger.userId,
            },
            commit: check.commit,
            result: check.result,
            version_id: check.versionId,
            issues: check.issues,
            auto_approval:
              check.autoApproval === null
                ? null
                : {
                    result: check.autoApproval.result,
                    reason: check.autoApproval.reason,
                    checks: check.autoApproval.checks,
                  },
          },
  };
}

export function createSkillGitSync(
  deps: SkillGitSyncDeps & {
    /** Whether GitHub can reach this installation's webhook route. */
    webhookUrl: string | null;
  },
) {
  const { sources, reader, authorization } = deps;
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? SKILL_CHECK_LEASE_MS;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const running = new Set<Promise<unknown>>();

  const skillFiles = (name: string, files: BundleInputFile[]) =>
    files.map((file) => ({ ...file, path: `skills/${name}/${file.path}` }));
  const issuesOf = (name: string, issues: BundleIssue[]): SkillSyncIssue[] => {
    const root = `skills/${name}/`;
    return issues.slice(0, 20).map((issue) => ({
      path: issue.path.startsWith(root)
        ? issue.path.slice(root.length)
        : issue.path,
      code: issue.code,
      message: issue.message,
    }));
  };

  async function credentialOf(source: SkillGitSource) {
    return (
      (await deps.apps(source.workspaceId)).find(
        (app) => app.id === source.connectionId,
      ) ?? null
    );
  }

  /** One run of the check; records its outcome, throws only off GitHub. */
  async function once(
    workspaceId: string,
    name: string,
    trigger: SkillSyncTrigger,
    token: string,
  ): Promise<void> {
    const source = await sources.get(workspaceId, name);
    if (source === null) return;
    // Only "지금 확인" runs while paused; a trigger kept while sync was
    // being paused is dropped like the rest.
    if (!source.syncEnabled && trigger.kind !== "manual") return;
    const at = now();
    const record = (
      result: SkillSyncCheck["result"],
      commit: string | null,
      issues: SkillSyncIssue[] = [],
    ) =>
      sources.recordCheck(
        workspaceId,
        name,
        {
          at,
          trigger,
          commit,
          result,
          versionId: null,
          issues,
          autoApproval: null,
        },
        token,
      );
    const app = await credentialOf(source);
    if (app === null) return record("github_unavailable", null);
    let commit: string | null;
    try {
      commit = await reader.resolve(
        app,
        source.installationId,
        source.repositoryId,
        source.ref,
      );
    } catch (error) {
      if (!(error instanceof GitHubAppCheckError)) throw error;
      return record("github_unavailable", null);
    }
    if (commit === null) return record("source_missing", null);
    let tree: GitHubSkillTree;
    try {
      tree = await reader.read(
        app,
        source.installationId,
        source.repositoryId,
        commit,
        source.path,
      );
    } catch (error) {
      if (!(error instanceof GitHubAppCheckError)) throw error;
      return record("github_unavailable", commit);
    }
    if (tree.kind === "missing") return record("source_missing", commit);
    if (tree.kind === "refused") return record("rejected", commit, tree.issues);
    // The write reads the settings again under the source row's lock
    // before it approves anything.
    const grantId = source.autoApprove.grantId;
    const auto =
      source.autoApprove.state === "on" &&
      source.syncEnabled &&
      grantId !== null
        ? { grantId }
        : undefined;
    const result = await deps.bundles.register({
      principal: { ownerId: workspaceId },
      slug: name,
      files: skillFiles(name, tree.files),
      label: name,
      source: "github",
      skill: true,
      git: {
        location: {
          repositoryId: source.repositoryId,
          path: source.path,
          ref: source.ref,
          commit,
        },
        trigger,
        checkedAt: at,
        ...(auto === undefined ? {} : { auto }),
        leaseToken: token,
      },
    });
    if (result.outcome === "rejected") {
      return record("rejected", commit, issuesOf(name, result.issues));
    }
    // registered, already_registered and paused are recorded with the
    // version's own write; a source that went away, or a lease another
    // check took over, has nothing to record.
  }

  /**
   * Runs the check for one skill, or leaves the trigger for the check that
   * holds it. The holder runs once more for what arrived meanwhile.
   */
  async function check(
    workspaceId: string,
    name: string,
    trigger: SkillSyncTrigger,
  ): Promise<"checked" | "queued" | "not_found"> {
    const begun = await sources.begin(workspaceId, name, trigger, leaseMs);
    if (begun.outcome !== "started") return begun.outcome;
    const { token } = begun;
    let next: SkillSyncTrigger | null = trigger;
    let failure: { error: unknown } | null = null;
    try {
      while (next !== null) {
        // A run that fails still lets a trigger kept meanwhile run.
        try {
          await once(workspaceId, name, next, token);
        } catch (error) {
          failure ??= { error };
        }
        next = await sources.finish(workspaceId, name, leaseMs, token);
      }
    } catch (error) {
      // The store failed: let the skill go; the lease would once it passes.
      await sources.finish(workspaceId, name, 0, token).catch(() => undefined);
      throw error;
    }
    if (failure !== null) throw failure.error;
    return "checked";
  }

  function inBackground(
    workspaceId: string,
    name: string,
    trigger: SkillSyncTrigger,
  ) {
    const run = check(workspaceId, name, trigger)
      .catch((error) =>
        deps.failed?.(error, { workspace_id: workspaceId, skill: name }),
      )
      .finally(() => running.delete(run));
    running.add(run);
  }

  function webUser(caller: Caller): string {
    const userId = caller.actor?.userId;
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user" ||
      !userId
    ) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Skills are changed from a signed-in console session, not with an API key",
        undefined,
        { reason_code: "web_session_required" },
      );
    }
    return userId;
  }

  async function manager(caller: Caller): Promise<string> {
    const userId = webUser(caller);
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });
    return userId;
  }

  async function webhookStates(workspaceId: string) {
    if (deps.webhookUrl === null) return () => "no_public_url" as const;
    const secrets = await Promise.all(
      (await deps.apps(workspaceId)).map(async (app) => ({
        id: app.id,
        set: (await deps.webhookSecrets(app.appId)).some(
          (one) => one.connectionId === app.id,
        ),
      })),
    );
    return (connectionId: string) =>
      secrets.some((one) => one.id === connectionId && one.set)
        ? ("ready" as const)
        : ("no_secret" as const);
  }

  async function sourceView(source: SkillGitSource) {
    return skillGitSourceView(
      source,
      (await webhookStates(source.workspaceId))(source.connectionId),
    );
  }

  return {
    check,

    /** For the skill list: every source of the workspace, as the API shows it. */
    async views(workspaceId: string) {
      const [all, states] = await Promise.all([
        sources.list(workspaceId),
        webhookStates(workspaceId),
      ]);
      return new Map(
        all.map((source) => [
          source.name,
          skillGitSourceView(source, states(source.connectionId)),
        ]),
      );
    },

    /**
     * A push delivery. Only a body whose signature one stored secret of App
     * `appId` verifies is read, and only for which skills to check; the
     * checks run after this returns.
     */
    async receive(input: {
      appId: string | null;
      event: string | null;
      deliveryId: string | null;
      signature: string | null;
      body: Uint8Array;
    }): Promise<"unauthorized" | "accepted"> {
      const appId = asNumber(Number(input.appId));
      if (appId === null || input.signature === null) return "unauthorized";
      const signature = input.signature;
      const verified = (await deps.webhookSecrets(appId)).filter((one) =>
        githubSignatureMatches(one.secret, input.body, signature),
      );
      if (verified.length === 0) return "unauthorized";
      if (input.event !== "push") return "accepted";
      const target = pushTarget(input.body);
      if (target === null) return "accepted";
      const matched = await sources.matching({
        connectionIds: verified.map((one) => one.connectionId),
        ...target,
      });
      for (const source of matched) {
        inBackground(source.workspaceId, source.name, {
          kind: "webhook",
          deliveryId: input.deliveryId,
          userId: null,
        });
      }
      return "accepted";
    },

    /** Checks the sources whose last check is a day old; returns how many. */
    async daily(): Promise<number> {
      const due = await sources.due(
        new Date(now().getTime() - SKILL_DAILY_INTERVAL_MS),
        DAILY_BATCH,
        SKILL_DAILY_CLAIM_MS,
      );
      for (const { workspaceId, name } of due) {
        await check(workspaceId, name, {
          kind: "daily",
          deliveryId: null,
          userId: null,
        }).catch((error) =>
          deps.failed?.(error, { workspace_id: workspaceId, skill: name }),
        );
      }
      return due.length;
    },

    /** Resolves when the checks webhooks started have ended (tests). */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running]);
    },

    async register(
      caller: Caller,
      request: RegisterGitHubSkillRequest,
    ): Promise<RegisterSkillResponse> {
      const userId = await manager(caller);
      const authors = await deps.apps(caller.ownerId);
      const app =
        request.connection_id === undefined
          ? authors.length === 1
            ? authors[0]
            : undefined
          : authors.find((one) => one.id === request.connection_id);
      if (app === undefined) {
        throw refused(
          request.connection_id === undefined
            ? "connection_required"
            : "connection_not_found",
          request.connection_id === undefined
            ? "Name the author App connection that reads the repository"
            : "No author App connection of the workspace has that id",
        );
      }
      const [owner = "", repo = ""] = request.repository.split("/");
      let installation: { id: number } | null;
      let repository: { id: number; fullName: string } | null = null;
      let commit: string | null = null;
      let tree: GitHubSkillTree | null = null;
      try {
        installation = await deps.installationFor(app, { owner, name: repo });
        if (installation !== null) {
          repository = await reader.repository(
            app,
            installation.id,
            owner,
            repo,
          );
        }
        if (installation !== null && repository !== null) {
          commit = await reader.resolve(
            app,
            installation.id,
            repository.id,
            request.ref,
          );
          if (commit !== null) {
            tree = await reader.read(
              app,
              installation.id,
              repository.id,
              commit,
              request.path,
            );
          }
        }
      } catch (error) {
        throw unavailable(error);
      }
      if (installation === null || repository === null) {
        throw refused(
          "repository_not_installed",
          "The App is not installed on that repository",
        );
      }
      if (commit === null) {
        throw refused("ref_not_found", "The ref names no commit");
      }
      if (tree === null || tree.kind === "missing") {
        throw refused(
          "path_not_found",
          "The path is not a directory at that commit",
        );
      }
      if (tree.kind === "refused") {
        throw refused("skill_invalid", "The skill did not pass the checks", {
          issues: tree.issues,
        });
      }
      const result = await deps.bundles.register({
        principal: caller,
        slug: request.name,
        files: skillFiles(request.name, tree.files),
        label: request.name,
        source: "github",
        skill: true,
        git: {
          location: {
            repositoryId: repository.id,
            path: request.path,
            ref: request.ref,
            commit,
          },
          trigger: { kind: "register", deliveryId: null, userId },
          checkedAt: now(),
          newSource: {
            connectionId: app.id,
            installationId: installation.id,
            repositoryId: repository.id,
            repository: repository.fullName,
          },
        },
      });
      switch (result.outcome) {
        case "rejected":
          throw refused("skill_invalid", "The skill did not pass the checks", {
            issues: issuesOf(request.name, result.issues),
          });
        case "registered":
          return {
            outcome: "registered",
            version: skillVersionViewOf(result.bundle),
            receipt_id: result.receiptId,
          };
        case "already_registered":
        case "source_mismatch":
        case "name_taken":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            `"${request.name}" already has versions; a source is fixed by the first registration, so register it under another name`,
            undefined,
            { reason_code: "source_mismatch" },
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "paused":
        case "lease_lost":
          throw new Error(
            `a first registration reached the ${result.outcome} path`,
          );
      }
    },

    /** "지금 확인": runs even while paused, and waits for the check. */
    async checkNow(caller: Caller, name: string): Promise<CheckSkillResponse> {
      const userId = await manager(caller);
      const outcome = await check(caller.ownerId, name, {
        kind: "manual",
        deliveryId: null,
        userId,
      });
      if (outcome === "not_found") throw NOT_FOUND();
      const source = await sources.get(caller.ownerId, name);
      if (source === null) throw NOT_FOUND();
      return {
        outcome,
        last_check: skillGitSourceView(source, "ready").last_check,
      };
    },

    async setSync(
      caller: Caller,
      name: string,
      enabled: boolean,
    ): Promise<SkillSyncResponse> {
      const userId = await manager(caller);
      const result = await sources.setEnabled({
        workspaceId: caller.ownerId,
        name,
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
        case "unchanged":
          return {
            name,
            git: await sourceView(result.source),
            receipt_id: null,
          };
        case "updated": {
          let source = result.source;
          if (enabled) {
            // Turning sync back on checks once, right away.
            await check(caller.ownerId, name, {
              kind: "resume",
              deliveryId: null,
              userId,
            });
            source = (await sources.get(caller.ownerId, name)) ?? source;
          }
          return {
            name,
            git: await sourceView(source),
            receipt_id: result.receiptId,
          };
        }
      }
    },

    /**
     * Auto-approve: one manager turns it on or off. Turning it on reads
     * GitHub first for whether the ref is a branch, and then checks once,
     * so a version already waiting is judged too.
     */
    async setAutoApprove(
      caller: Caller,
      name: string,
      action: "on" | "off",
    ): Promise<SkillSyncResponse> {
      const userId = await manager(caller);
      if (action === "on") {
        const source = await sources.get(caller.ownerId, name);
        if (source === null) throw NOT_FOUND();
        const app = await credentialOf(source);
        if (app === null) {
          throw unavailable(new GitHubAppCheckError("github_rejected"));
        }
        let branch: boolean;
        try {
          branch = await reader.isBranch(
            app,
            source.installationId,
            source.repositoryId,
            source.ref,
          );
        } catch (error) {
          if (!(error instanceof GitHubAppCheckError)) throw error;
          throw unavailable(error);
        }
        if (!branch) {
          throw refused(
            "not_branch",
            "Auto-approve is for a branch; a tag or a commit is never auto-approved",
          );
        }
      }
      const result = await sources.setAutoApprove({
        workspaceId: caller.ownerId,
        name,
        action,
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
            name,
            git: await sourceView(result.source),
            receipt_id: null,
          };
        case "updated": {
          let source = result.source;
          // Paused sync approves nothing; its resume checks instead.
          if (action === "on" && source.syncEnabled) {
            await check(caller.ownerId, name, {
              kind: "auto_approve",
              deliveryId: null,
              userId,
            });
            source = (await sources.get(caller.ownerId, name)) ?? source;
          }
          return {
            name,
            git: await sourceView(source),
            receipt_id: result.receiptId,
          };
        }
      }
    },
  };
}

export type SkillGitSync = ReturnType<typeof createSkillGitSync>;
