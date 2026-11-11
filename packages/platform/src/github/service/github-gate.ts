import {
  GITHUB_AGENT_REF_PREFIX,
  GITHUB_FEATURES_NONE,
  type GitHubPurpose,
  type GitHubRefusal,
  githubAllowedBy,
  githubEffectiveFeatures,
  githubPermissionsFor,
  githubPolicyReceiptFields,
  pushDecisionOf,
} from "@werft-ai/contracts";
import {
  ForgeCredentialError,
  type GitCredential,
  repoRefOf,
} from "../../action/ports/forge.ts";
import {
  additionalContextOf,
  additionalRepositoriesOf,
  additionalRepositoryAllowed,
  repositoryInCeiling,
  type SessionCatalog,
  usesWorkspaceCeiling,
} from "../../sessions/index.ts";
import {
  type GitHubConnections,
  type GitHubGate,
  GitHubGateError,
  type GitHubGateReceipt,
  type GitHubGateStore,
  type GitHubGrant,
  GitHubPermissionError,
  GitHubUnavailableError,
  type GitHubWork,
} from "../ports/github-gate.ts";
import {
  createGitHubConnectionResolver,
  type GitHubConnectionResolver,
} from "./github-connection-resolver.ts";

const ANOTHER_REPOSITORY_PURPOSES: ReadonlySet<GitHubPurpose> = new Set([
  "clone",
  "push",
  "pull_request",
  "outcome_refresh",
]);

const NEEDS_SESSION_REPOSITORY_PURPOSES: ReadonlySet<GitHubPurpose> = new Set([
  "actions_read",
  "dispatch",
  "rerun",
  "review",
]);

/**
 * The one place a GitHub credential is issued (design github-agent.md §3).
 * Every grant reads the session, its release and agent again, so a switch
 * turned off or a ceiling lowered refuses the next piece of work even when
 * the connection still caches a token for it.
 */
export function createGitHubGate(deps: {
  store: GitHubGateStore;
  catalog: SessionCatalog;
  connections: GitHubConnections;
  resolver?: GitHubConnectionResolver;
}): GitHubGate {
  const { store, catalog, connections } = deps;
  const resolver =
    deps.resolver ??
    createGitHubConnectionResolver({ connections, pins: null });

  return {
    async grant(work: GitHubWork): Promise<GitHubGrant | null> {
      const context = await store.context(work.sessionId);
      if (context === null) {
        throw new GitHubUnavailableError("The session was not found");
      }
      const operation: GitHubGateReceipt["operation"] =
        work.purpose === "dispatch"
          ? "dispatch_workflow"
          : work.purpose === "rerun"
            ? "rerun_workflow"
            : work.purpose === "review"
              ? "review_pull_request"
              : work.purpose === "merge"
                ? "merge_pull_request"
                : "mint_github_token";
      const own =
        work.repositoryId === undefined ||
        work.repositoryId === context.repositoryId;
      const repositoryId = own
        ? context.repositoryId
        : (work.repositoryId ?? null);
      const policyFields = githubPolicyReceiptFields(
        context.policy,
        context.ceilingRevision,
      );
      const fields: Record<string, unknown> = {
        session_id: context.sessionId,
        agent_id: context.agent?.id ?? null,
        agent_release_id: context.release?.id ?? null,
        ...policyFields,
        repository_id: repositoryId,
        purpose: work.purpose,
        ...(work.workflow === undefined
          ? {}
          : { workflow: work.workflow.file, ref: work.workflow.ref }),
        ...(work.runId === undefined ? {} : { run_id: work.runId }),
        ...(work.review === undefined
          ? {}
          : {
              number: work.review.number,
              commit_id: work.review.commitId,
              event: work.review.event,
            }),
      };
      const receipt = (
        status: GitHubGateReceipt["status"],
        result: Record<string, unknown>,
        refusal: GitHubRefusal | null,
        as: GitHubGateReceipt["operation"],
      ) =>
        store.recordReceipt({
          ownerId: context.ownerId,
          sessionId: context.sessionId,
          actor:
            work.actor !== undefined
              ? work.actor
              : context.startedBy === null
                ? null
                : {
                    principal: { kind: "user", id: context.startedBy },
                    actor_user_id: context.startedBy,
                    agent_id: null,
                  },
          operation: as,
          status,
          result: { ...fields, ...result },
          error:
            refusal === null
              ? null
              : {
                  code: "GITHUB_REFUSED",
                  message: `GitHub work refused: ${refusal}`,
                },
        });
      const refuse = async (
        reason: GitHubRefusal,
        extra: Record<string, unknown> = {},
      ): Promise<never> => {
        const receiptId = await receipt(
          "failed",
          { reason_code: reason, ...extra },
          reason,
          operation,
        );
        throw new GitHubGateError(reason, receiptId);
      };

      if (repositoryId === null) {
        return await refuse(
          NEEDS_SESSION_REPOSITORY_PURPOSES.has(work.purpose)
            ? "workflow_review_need_session_repository"
            : "repository_none",
        );
      }
      // Reading a pull request the platform recorded is not the agent's
      // work: no switch, scope, feature or ceiling applies (§10).
      const platformRead = work.purpose === "outcome_refresh";
      const listed = Object.hasOwn(catalog.repositories, repositoryId)
        ? catalog.repositories[repositoryId]
        : undefined;
      // Another repository is fetched, pushed to and given pull requests;
      // its workflows and reviews stay with the session's own
      // (session-multi-repository.md decision 5).
      if (!own && !ANOTHER_REPOSITORY_PURPOSES.has(work.purpose)) {
        return await refuse("repository_not_allowed");
      }
      if (
        work.purpose === "push" &&
        pushDecisionOf(context.policy) === "deny"
      ) {
        return await refuse("repository_not_allowed");
      }
      let entry: SessionCatalog["repositories"][string];
      if (own) {
        if (
          listed === undefined ||
          context.repository === null ||
          listed.url !== context.repository.url ||
          listed.branch !== context.repository.branch
        ) {
          throw new GitHubUnavailableError("The session's repository moved");
        }
        entry = listed;
      } else if (platformRead) {
        if (listed === undefined) {
          throw new GitHubUnavailableError("The repository left the catalog");
        }
        entry = listed;
      } else {
        if (context.policy.settings === "invalid") {
          return await refuse("github_settings_unsupported");
        }
        const allowed = additionalRepositoryAllowed(
          catalog,
          additionalContextOf(context),
          repositoryId,
        );
        if (allowed === null) return await refuse("repository_not_allowed");
        entry = allowed;
      }
      const { policy } = context;
      const settings = policy.settings;
      // Before any credential path: these limits hold on every host.
      if (
        !platformRead &&
        usesWorkspaceCeiling(catalog, context.profileId, policy.source)
      ) {
        if (settings === "invalid") {
          return await refuse("github_settings_unsupported");
        }
        if (
          policy.source === "agent" &&
          !settings?.repositories.includes(repositoryId)
        ) {
          return await refuse("repository_not_allowed");
        }
        if (
          !repositoryInCeiling(catalog, context.repositoryCeiling, repositoryId)
        ) {
          return await refuse("repository_not_allowed");
        }
      }
      const source = connections(repositoryId, "author");
      // Console connections are all on github.com.
      const author = source?.kind === "fixed" ? source.connection : null;
      if (settings === "invalid") {
        return await refuse("github_settings_unsupported");
      }
      if (!platformRead) {
        if (context.agent !== null && !context.agent.githubEnabled) {
          return await refuse("github_disabled");
        }
        if (
          settings !== null &&
          !settings.repositories.includes(repositoryId)
        ) {
          return await refuse("repository_not_allowed");
        }
        // A release without a pin has no list of its own, but a person's
        // saved list still takes repositories away from it.
        if (
          policy.currentRepositories !== null &&
          !policy.currentRepositories.includes(repositoryId)
        ) {
          return await refuse("repository_not_allowed");
        }
      }
      const features = githubEffectiveFeatures(
        settings?.features ?? GITHUB_FEATURES_NONE,
        context.ceiling,
      );
      const needs = githubPermissionsFor(work.purpose, features);
      if (
        !platformRead &&
        needs.ceilingFeature !== undefined &&
        !context.ceiling[needs.ceilingFeature]
      ) {
        return await refuse("merge_off");
      }
      if (!platformRead && needs.feature !== null) {
        if (settings === null || !settings.features[needs.feature]) {
          return await refuse("feature_off");
        }
        if (!features[needs.feature]) {
          return await refuse("over_workspace_ceiling");
        }
        if (author !== null && !author.githubCom) {
          return await refuse("github_host_unsupported");
        }
      }

      let allowedBy: GitHubGrant["allowedBy"] = null;
      if (work.purpose === "dispatch" || work.purpose === "rerun") {
        let target = work.workflow;
        if (work.purpose === "rerun") {
          const recorded =
            work.runId === undefined
              ? null
              : await store.findDispatch(repositoryId, work.runId);
          if (recorded === null) return await refuse("run_ref_unprovable");
          target = { file: recorded.workflow, ref: recorded.ref };
          fields.workflow = recorded.workflow;
          fields.ref = recorded.ref;
        }
        if (target === undefined) return await refuse("workflow_not_allowed");
        if (target.ref.startsWith(GITHUB_AGENT_REF_PREFIX)) {
          return await refuse("agent_ref_refused");
        }
        allowedBy = githubAllowedBy(
          settings === null ? [] : settings.actions_allow,
          target.file,
          target.ref,
          entry.branch,
        );
        if (allowedBy === null) return await refuse("workflow_not_allowed");
        // Globs and default-branch meanings cannot be intersected, so the
        // list the session started with must allow the run as well.
        if (
          policy.startActionsAllow !== null &&
          githubAllowedBy(
            policy.startActionsAllow,
            target.file,
            target.ref,
            entry.branch,
          ) === null
        ) {
          return await refuse("workflow_not_allowed");
        }
        fields.allowed_by = allowedBy;
      }

      const repo = repoRefOf(entry.url);
      if (repo === null) {
        throw new GitHubUnavailableError("The repository URL names no repo");
      }
      const choice = await resolver.resolve(repositoryId, needs.role, repo, {
        pin: true,
        ...(needs.role === "author" ? { source } : {}),
      });
      if (choice.kind === "none") {
        if (needs.role === "reviewer") return await refuse("no_reviewer_app");
        throw new GitHubUnavailableError(
          "The repository's GitHub App is not registered",
        );
      }
      if (choice.kind === "refused") {
        return await refuse(
          choice.reason,
          choice.reason === "ambiguous_app"
            ? {
                role: needs.role,
                candidate_connection_ids: choice.candidateConnectionIds,
              }
            : { role: needs.role },
        );
      }
      if (choice.kind === "unreachable") {
        const receiptId = await receipt(
          "failed",
          {
            role: needs.role,
            connection_id: choice.connectionId,
            pin_state: choice.pinState,
          },
          null,
          operation,
        );
        const message =
          choice.pinState === "lookup_failed"
            ? "GitHub could not say which App reaches the repository"
            : "No GitHub App connection reaches the repository";
        // The author's work keeps the not-installed answer it had with one
        // App (forge_failed, push_failed); a review has its own.
        if (work.purpose !== "review") {
          throw new ForgeCredentialError(message, receiptId);
        }
        throw new GitHubUnavailableError(message, receiptId);
      }
      const { connection, connectionId } = choice;
      let gitCredential: GitCredential;
      let fresh: boolean;
      try {
        ({ credential: gitCredential, fresh } = await connection.credential(
          repo,
          needs.permissions,
        ));
      } catch (error) {
        if (error instanceof GitHubPermissionError) {
          return await refuse("app_permission_missing", {
            role: needs.role,
            connection_id: connectionId,
          });
        }
        // An App registered but not installed on the repository (a reviewer,
        // or a console connection pinned there): the attempt still leaves
        // its receipt.
        if (
          error instanceof ForgeCredentialError &&
          (work.purpose === "review" || connectionId !== null)
        ) {
          const receiptId = await receipt(
            "failed",
            {
              role: needs.role,
              app_id: connection.appId,
              connection_id: connectionId,
              ...(connectionId === null
                ? {}
                : { pin_state: "pinned_unreachable" }),
            },
            null,
            operation,
          );
          if (work.purpose !== "review") {
            throw new ForgeCredentialError(error.message, receiptId);
          }
          throw new GitHubUnavailableError(error.message, receiptId);
        }
        throw error;
      }
      if (fresh) {
        await receipt(
          "succeeded",
          {
            role: needs.role,
            connection_id: connectionId,
            ...(choice.pinnedBy === null ? {} : { pinned_by: choice.pinnedBy }),
            app_id: connection.appId,
            permissions: needs.permissions,
            expires_at: gitCredential.expiresAt?.toISOString() ?? null,
          },
          null,
          "mint_github_token",
        );
      }
      return {
        role: needs.role,
        repo,
        permissions: needs.permissions,
        gitCredential,
        api: connection.api(repo, gitCredential),
        unit: () => connection.quotaKey(repo),
        allowedBy,
        context: {
          ownerId: context.ownerId,
          sessionId: context.sessionId,
          agentId: context.agent?.id ?? null,
          agentReleaseId: context.release?.id ?? null,
          repositoryId,
          policy: policyFields,
        },
      };
    },

    async additionalRepositories(sessionId: string): Promise<string[]> {
      const context = await store.context(sessionId);
      if (context === null) return [];
      return additionalRepositoriesOf(catalog, additionalContextOf(context))
        .filter(
          ({ id, repository }) =>
            connections(id, "author") !== null ||
            repository.auth?.kind === "github_app",
        )
        .map(({ id }) => id);
    },
  };
}
