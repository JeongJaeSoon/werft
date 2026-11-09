import {
  type AgentGitHub,
  additionalRepositoryIdUsable,
  type GitHubPolicySource,
  type RepositoryCeiling,
} from "@werft-ai/contracts";
import type { GitHubSessionContext } from "../ports/github-gate.ts";
import {
  allowedPair,
  type CatalogProfileView,
  type CatalogRepositoryView,
  type ProfileLookup,
  repositoryInCeiling,
  usesWorkspaceCeiling,
} from "./catalog.ts";

/**
 * What decides whether a session may work on a repository other than its
 * own (design session-multi-repository.md decision 1): the release's list
 * caps it and the session row's attached list, when there is one, narrows
 * it. Read again on every use, so a repository the owner takes off the
 * release's list stops at the next fetch, push or pull request.
 */
export type AdditionalRepositoryContext = {
  repositoryId: string | null;
  profileId: string | null;
  /** The session row's list; null leaves the release's list whole. */
  attached: readonly string[] | null;
  policySource: GitHubPolicySource;
  /** Null when the session has no agent, or the agent's switch is off. */
  github: AgentGitHub | "invalid" | null;
  repositoryCeiling: RepositoryCeiling | null;
  githubEnabled: boolean;
};

export function additionalContextOf(
  context: GitHubSessionContext,
): AdditionalRepositoryContext {
  return {
    repositoryId: context.repositoryId,
    profileId: context.profileId,
    attached: context.attachedRepositoryIds,
    policySource: context.policy.source,
    github: context.policy.settings,
    repositoryCeiling: context.repositoryCeiling,
    githubEnabled: context.agent?.githubEnabled ?? false,
  };
}

export function additionalRepositoryAllowed<
  P extends CatalogProfileView,
  R extends CatalogRepositoryView,
>(
  catalog: ProfileLookup<P> & { repositories: Record<string, R> },
  context: AdditionalRepositoryContext,
  repositoryId: string,
): R | null {
  const { github, profileId, policySource } = context;
  if (
    repositoryId === context.repositoryId ||
    !context.githubEnabled ||
    github === null ||
    github === "invalid" ||
    profileId === null ||
    (context.attached !== null && !context.attached.includes(repositoryId)) ||
    !github.repositories.includes(repositoryId) ||
    !additionalRepositoryIdUsable(repositoryId)
  ) {
    return null;
  }
  if (
    usesWorkspaceCeiling(catalog, profileId, policySource) &&
    !repositoryInCeiling(catalog, context.repositoryCeiling, repositoryId)
  ) {
    return null;
  }
  return (
    allowedPair(catalog, profileId, repositoryId, policySource)?.repository ??
    null
  );
}

/** Every repository besides its own the session may work on, in list order. */
export function additionalRepositoriesOf<
  P extends CatalogProfileView,
  R extends CatalogRepositoryView,
>(
  catalog: ProfileLookup<P> & { repositories: Record<string, R> },
  context: AdditionalRepositoryContext,
): Array<{ id: string; repository: R }> {
  const github = context.github;
  if (github === null || github === "invalid") return [];
  return github.repositories.flatMap((id) => {
    const repository = additionalRepositoryAllowed(catalog, context, id);
    return repository === null ? [] : [{ id, repository }];
  });
}

/**
 * Whether the session's own repository is one its agent's settings no longer
 * allow: the switch is off, or the saved list or the workspace ceiling has
 * dropped it. The gate refuses it with the same conditions. A policy that is
 * missing or unreadable says nothing about the repository, so it is not
 * revoked here.
 */
export function ownRepositoryRevoked(
  catalog: ProfileLookup<CatalogProfileView> & {
    repositories: Record<string, CatalogRepositoryView>;
  },
  context: GitHubSessionContext,
): boolean {
  const own = context.repositoryId;
  if (own === null || context.agent === null) return false;
  if (!context.agent.githubEnabled) return true;
  const { settings, currentRepositories, source } = context.policy;
  if (settings === null || settings === "invalid") return false;
  if (!settings.repositories.includes(own)) return true;
  if (currentRepositories !== null && !currentRepositories.includes(own)) {
    return true;
  }
  return (
    usesWorkspaceCeiling(catalog, context.profileId, source) &&
    !repositoryInCeiling(catalog, context.repositoryCeiling, own)
  );
}
