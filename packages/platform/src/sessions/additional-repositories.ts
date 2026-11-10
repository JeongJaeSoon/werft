import {
  type AgentGitHub,
  additionalRepositoryIdUsable,
  type GitHubPolicySource,
  type RepositoryCeiling,
} from "@werft-ai/contracts";
import type { GitHubSessionContext } from "../ports/github-gate.ts";
import { type CatalogRepositoryView, repositoryInCeiling } from "./catalog.ts";

/**
 * What decides whether a session may work on a repository other than its
 * own (design session-multi-repository.md decision 1): the release's list
 * caps it and the session row's attached list, when there is one, narrows
 * it. Read again on every use, so a repository the owner takes off the
 * release's list stops at the next fetch, push or pull request.
 */
export type AdditionalRepositoryContext = {
  repositoryId: string | null;
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
    attached: context.attachedRepositoryIds,
    policySource: context.policy.source,
    github: context.policy.settings,
    repositoryCeiling: context.repositoryCeiling,
    githubEnabled: context.agent?.githubEnabled ?? false,
  };
}

export function additionalRepositoryAllowed<R extends CatalogRepositoryView>(
  catalog: { repositories: Readonly<Record<string, R>> },
  context: AdditionalRepositoryContext,
  repositoryId: string,
): R | null {
  const { github } = context;
  if (
    repositoryId === context.repositoryId ||
    !context.githubEnabled ||
    github === null ||
    github === "invalid" ||
    (context.attached !== null && !context.attached.includes(repositoryId)) ||
    !github.repositories.includes(repositoryId) ||
    !additionalRepositoryIdUsable(repositoryId)
  ) {
    return null;
  }
  if (!repositoryInCeiling(catalog, context.repositoryCeiling, repositoryId)) {
    return null;
  }
  return Object.hasOwn(catalog.repositories, repositoryId)
    ? (catalog.repositories[repositoryId] ?? null)
    : null;
}

/** Every repository besides its own the session may work on, in list order. */
export function additionalRepositoriesOf<R extends CatalogRepositoryView>(
  catalog: { repositories: Readonly<Record<string, R>> },
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
 * Whether the session's own repository is one the gate now refuses on policy:
 * the agent's switch is off, or its saved list, a person's saved list or the
 * workspace ceiling has dropped it. These are the gate's own conditions; it
 * checks the ceiling first, which only changes which refusal it names. A policy that is unreadable says nothing about the repository,
 * so it is not revoked here.
 */
export function ownRepositoryRevoked(
  catalog: { repositories: Readonly<Record<string, CatalogRepositoryView>> },
  context: GitHubSessionContext,
): boolean {
  const own = context.repositoryId;
  if (own === null) return false;
  const { settings, currentRepositories } = context.policy;
  if (settings === "invalid") return false;
  if (context.agent !== null && !context.agent.githubEnabled) return true;
  // A release without a pin has no list of its own (`settings` is null), but
  // a person's saved list still takes repositories away from it.
  if (settings !== null && !settings.repositories.includes(own)) return true;
  if (currentRepositories !== null && !currentRepositories.includes(own)) {
    return true;
  }
  return !repositoryInCeiling(catalog, context.repositoryCeiling, own);
}
