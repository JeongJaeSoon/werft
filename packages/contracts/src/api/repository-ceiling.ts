import { z } from "zod";

/**
 * Whether a session names a repository: `required` always, `optional` may,
 * `none` never. Every release made now runs `optional`; the agent's GitHub
 * settings and the workspace ceiling judge which repositories it reaches.
 */
export const repositoryModeSchema = z.enum(["required", "optional", "none"]);

/**
 * Which GitHub App repositories the workspace ceiling reaches besides its
 * `repository_ids`: `listed` none, `installed` every one the author App's
 * installations reach.
 */
export const GITHUB_APP_REPOSITORIES_VALUES = ["listed", "installed"] as const;
export const githubAppRepositoriesSchema = z.enum(
  GITHUB_APP_REPOSITORIES_VALUES,
);
export type GitHubAppRepositories = z.infer<typeof githubAppRepositoriesSchema>;

/** The repositories agent sessions of a workspace may reach. */
export const repositoryCeilingSchema = z
  .object({
    repository_ids: z.array(z.string().min(1).max(128)),
    github_app_repositories: githubAppRepositoriesSchema,
  })
  .strict();
export type RepositoryCeiling = z.infer<typeof repositoryCeilingSchema>;

/** Null, for no value or one a later image wrote: nothing is allowed. */
export function repositoryCeilingOf(stored: unknown): RepositoryCeiling | null {
  const parsed = repositoryCeilingSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}
