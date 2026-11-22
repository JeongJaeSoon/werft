import type { SessionSummary } from "@werft-ai/contracts";
import { Code, cn } from "@werft-ai/ui";
import type { JSX } from "react";

/** What the session's repository fields say, which a screen reads as one list. */
export type SessionRepositorySource = Pick<
  SessionSummary,
  | "repository_id"
  | "repository"
  | "attached_repositories"
  | "attached_repository_ids"
>;

export interface SessionRepositoryEntry {
  readonly id: string | null;
  /** Null for a legacy row that kept neither a name nor a key. */
  readonly name: string | null;
  /** The branch the workspace was cloned from; only the session's own has one. */
  readonly branch: string | null;
}

const byKey = (a: SessionRepositoryEntry, b: SessionRepositoryEntry) => {
  const left = a.id ?? a.name ?? "";
  const right = b.id ?? b.name ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * The repositories a session works on, as one list in id order: its own and
 * the attached ones, an id once (the session's own wins). An older server
 * sends the attached ids without names, which then stand in for them.
 */
export function sessionRepositoriesOf(
  session: SessionRepositorySource,
): SessionRepositoryEntry[] {
  const own: SessionRepositoryEntry | null = session.repository
    ? {
        id: session.repository.id ?? session.repository_id,
        name: session.repository.full_name,
        branch: session.repository.branch,
      }
    : session.repository_id
      ? { id: session.repository_id, name: session.repository_id, branch: null }
      : null;
  const attached =
    session.attached_repositories ??
    session.attached_repository_ids?.map((id) => ({
      id,
      full_name: null,
    })) ??
    [];
  const seen = new Set<string>(own?.id ? [own.id] : []);
  const rest: SessionRepositoryEntry[] = [];
  for (const { id, full_name } of attached) {
    if (seen.has(id)) continue;
    seen.add(id);
    rest.push({ id, name: full_name ?? id, branch: null });
  }
  return [...(own ? [own] : []), ...rest].sort(byKey);
}

/** The name a person reads: `owner/repo`, or the key a name was never made from. */
export const repositoryLabel = (
  repository: SessionRepositoryEntry,
  unknown: string,
): string => repository.name ?? repository.id ?? unknown;

const withBranch = (label: string, branch: string | null) =>
  branch ? `${label} · ${branch}` : label;

/**
 * One repository on one line: a long name gives way first, so the branch
 * stays in sight. `relative` lifts it above a row's opener, so hovering shows
 * the whole name.
 */
export function RepositoryName({
  repository,
  unknown,
  className,
}: {
  readonly repository: SessionRepositoryEntry;
  readonly unknown: string;
  readonly className?: string | undefined;
}): JSX.Element {
  const label = repositoryLabel(repository, unknown);
  return (
    <Code
      className={cn("relative flex min-w-0", className)}
      title={withBranch(label, repository.branch)}
    >
      <span className="min-w-0 truncate">{label}</span>
      {repository.branch ? (
        <span className="max-w-[50%] flex-none overflow-hidden text-ellipsis whitespace-pre">
          {` · ${repository.branch}`}
        </span>
      ) : null}
    </Code>
  );
}
