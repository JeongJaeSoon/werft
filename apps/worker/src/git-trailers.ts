import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ClaimGit,
  type ClaimGitAuthor,
  IMAGE_GIT_AUTHOR,
} from "@werft-ai/contracts";
import {
  type GitEnvironment,
  type GitEnvironmentKey,
  gitEnvironment,
} from "@werft-ai/runtime-core";

// The image's commit-msg hook (apps/worker/git-hooks/werft-hook) reads this
// file under the engine's HOME and adds each line as a `--trailer` argv.
export const GIT_TRAILERS_PATH = ".werft/git-trailers";
// The image's system git config includes this file after its own
// user.name/email (apps/worker/Dockerfile), so the session's author wins over
// the image default. The engine's own git also gets the author from
// gitEnvironmentFor, which outranks a repository's config as well.
export const GIT_IDENTITY_PATH = ".werft/git-identity";
// The engine emails whose Co-authored-by lines the hook removes, one per
// line (werft-trailers.sh).
export const GIT_STRIP_PATH = ".werft/git-strip";
// The image's hook directory, core.hooksPath in its system config
// (apps/worker/Dockerfile); absent outside the image.
export const IMAGE_GIT_HOOKS = "/usr/local/share/werft/git-hooks";
// The image's default author and committer (apps/worker/Dockerfile).
export { IMAGE_GIT_AUTHOR };

const UNSAFE = /[\r\n\0]/;
const BOT_NAME = /^[a-z0-9][a-z0-9-]*\[bot\]$/;
const BOT_EMAIL =
  /^[1-9][0-9]*\+[a-z0-9][a-z0-9-]*\[bot\]@users\.noreply\.github\.com$/;

/** What a claim says about the session's commits. */
export type ClaimCommits = {
  session_id: string;
  git?: ClaimGit | undefined;
  git_author?: ClaimGitAuthor | null | undefined;
  git_strip?: readonly string[] | undefined;
};

/**
 * The trailer lines a claim asks for; a value that could break a line is
 * dropped. Without a console URL, Agent-Session names the session's id: the
 * pull request's tail carries the same id.
 */
export function gitTrailerLines(claim: ClaimCommits): string[] {
  const { git } = claim;
  const lines: string[] = [];
  const coAuthor = git?.co_author;
  if (coAuthor && !UNSAFE.test(coAuthor.name) && !UNSAFE.test(coAuthor.email)) {
    lines.push(`Co-authored-by: ${coAuthor.name} <${coAuthor.email}>`);
  }
  if (git !== undefined) {
    const session = git.session_url ?? claim.session_id;
    if (!UNSAFE.test(session)) lines.push(`Agent-Session: ${session}`);
  }
  return lines;
}

/**
 * The git config the image includes for the commit author, or null when the
 * claim names none or one this file could not hold as a plain value.
 */
export function gitIdentityConfig(author: ClaimGitAuthor | null | undefined) {
  if (!author || !BOT_NAME.test(author.name) || !BOT_EMAIL.test(author.email)) {
    return null;
  }
  return `[user]\n\tname = "${author.name}"\n\temail = ${author.email}\n`;
}

/**
 * The git settings the engine runs under (runtime-core gitEnvironment):
 * the image's hook directory, so a repository's own core.hooksPath (husky)
 * cannot switch the platform hook off, and the claim's author, so a
 * repository's local user.* cannot replace it. A claim that names no usable
 * bot gets the image default stated the same way; one from an API without
 * `git_author` leaves the author to git's usual order. Without `hooksPath`
 * (outside the image) no hook directory is set.
 */
export function gitEnvironmentFor(
  claim: Pick<ClaimCommits, "git_author">,
  hooksPath: string | undefined,
): GitEnvironment | undefined {
  const entries: { key: GitEnvironmentKey; value: string }[] = [];
  if (hooksPath !== undefined && hooksPath !== "") {
    entries.push({ key: "core.hooksPath", value: hooksPath });
  }
  if (claim.git_author !== undefined) {
    const author =
      gitIdentityConfig(claim.git_author) === null
        ? IMAGE_GIT_AUTHOR
        : (claim.git_author as ClaimGitAuthor);
    entries.push(
      { key: "user.name", value: author.name },
      { key: "user.email", value: author.email },
    );
  }
  return gitEnvironment(entries);
}

const STRIP_EMAIL = /^[^\s<>@]+@[^\s<>@]+$/;

function gitStripFile(emails: readonly string[] | undefined): string | null {
  const kept = (emails ?? []).filter(
    (email) => STRIP_EMAIL.test(email) && !UNSAFE.test(email),
  );
  return kept.length === 0 ? null : `${kept.join("\n")}\n`;
}

/**
 * Replaces the trailers and identity files with this claim's, or removes
 * each one the claim has nothing for: a claim from a control host without
 * `git` adds nothing, and one without `git_author` keeps the image default.
 */
export async function writeGitTrailers(
  home: string,
  claim: ClaimCommits,
): Promise<void> {
  const lines = gitTrailerLines(claim);
  await replace(
    home,
    GIT_TRAILERS_PATH,
    lines.length === 0 ? null : `${lines.join("\n")}\n`,
  );
  await replace(home, GIT_IDENTITY_PATH, gitIdentityConfig(claim.git_author));
  await replace(home, GIT_STRIP_PATH, gitStripFile(claim.git_strip));
}

async function replace(
  home: string,
  file: string,
  content: string | null,
): Promise<void> {
  const path = join(home, file);
  if (content === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(join(home, ".werft"), { recursive: true });
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, content, { mode: 0o644 });
  await rename(staged, path);
}
