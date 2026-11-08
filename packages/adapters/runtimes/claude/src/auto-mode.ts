/**
 * The auto mode classifier's platform rules, handed to the engine as flag
 * settings: the engine reads `autoMode` only from user, flag and policy
 * settings, so a repository's `.claude/settings.json` cannot widen or drop
 * them. "$defaults" keeps the engine's own rules around them.
 *
 * Each rule names a kind of action, not a tool; the environment entry is
 * where tool names map to those actions.
 */
export const PLATFORM_AUTO_MODE = {
  allow: [
    "$defaults",
    "Werft Git Work: Committing changes in this session's workspace, and pushing them to GitHub through the platform's push flow, which pushes only this session's saved checkpoint to an agent work branch the platform created for this session, in this session's own repository. Not covered: pushing to the default branch, a protected branch or any branch the platform did not create for this session; force pushes or rewriting pushed history; pushing to any other repository, including one attached to this session to read; committing secrets or credentials.",
    "Werft Pull Requests: Opening a pull request from such an agent work branch, and editing the title and description of, commenting on, closing or reopening a pull request this session opened. Not covered: merging or approving pull requests; submitting a review, including on a pull request this session opened; editing, commenting on, closing or reopening pull requests this session did not open; secrets in pull request text or comments.",
    "Werft Repository Reading: Listing the repositories the agent was granted, and attaching one of them to read its code. Not covered: writing to an attached repository.",
  ],
  soft_deny: [
    "$defaults",
    "Werft GitHub Administration: changing repository settings, branch protection, webhooks, deploy keys or Actions secrets, deleting branches or repositories on GitHub, and merging pull requests, by any route.",
  ],
  environment: [
    "$defaults",
    "**Werft session**: this workspace is a Werft session. The session's repository, and any repository attached with `mcp__github__attach_repository`, is fetched read-only through the platform. `gh` is installed but has no GitHub login, and the GitHub API is not on the session's default egress allowlist: `git push`, `gh` and direct GitHub API calls do not reach GitHub from here unless an operator opened it. With that default, writes to GitHub go only through the built-in `github` MCP server, which pushes only to this session's own `agent/<session-id>` branches and applies the release's push approval on the server. The platform's push flow is the built-in `github` MCP server: `request_push` pushes, `open_pull_request`, `update_pull_request`, `comment_pull_request`, `close_pull_request` and `reopen_pull_request` act on pull requests, `list_repositories` and `attach_repository` read repositories.",
  ],
};

/**
 * The rules for a run whose push, pull request and repository-read tools
 * skip the classifier (`trusted`): the platform decides each of those on the
 * server, so no rule describes them. What is left is the engine's own work
 * (committing) and the tools the classifier still judges (reviews and
 * workflows).
 */
export const TRUSTED_PLATFORM_AUTO_MODE = {
  allow: [
    "$defaults",
    "Werft Git Work: Committing changes in this session's workspace. Not covered: committing secrets or credentials; pushing, which the platform does and `git push` does not reach GitHub from here.",
    "Werft Reviews and Workflows: Not covered: submitting a review, including on a pull request this session opened; dispatching or re-running a workflow.",
  ],
  soft_deny: PLATFORM_AUTO_MODE.soft_deny,
  environment: [
    "$defaults",
    "**Werft session**: this workspace is a Werft session. `gh` is installed but has no GitHub login, and the GitHub API is not on the session's default egress allowlist: `git push`, `gh` and direct GitHub API calls do not reach GitHub from here unless an operator opened it. Writes to GitHub go only through the built-in `github` MCP server, and the platform decides each of them on the server.",
  ],
};

/**
 * The full rules unless the platform vouched for its tools: a control host
 * from before `trusted` sends none, and then the classifier still judges
 * the push, pull request and repository-read tools by the first set.
 */
export function platformAutoMode(trusted: boolean) {
  return trusted ? TRUSTED_PLATFORM_AUTO_MODE : PLATFORM_AUTO_MODE;
}
