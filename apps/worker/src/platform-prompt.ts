import type { PlatformPrompt } from "@werft-ai/contracts";

/**
 * The platform's paragraph at the front of the appended system prompt: only
 * what the platform alone knows (the agent's name and description as its
 * author wrote them, where the session started, its repository and how
 * GitHub work goes) and its safety rules. The role is the author's to give,
 * in the instructions below. It has no branch on whether GitHub is set up:
 * that changes while a session runs, so the tools answer it. Every word is
 * part of the checkpoint fingerprint of the sessions of this revision, so a
 * change in wording is a new revision, never an edit here.
 */
export function platformPromptText(prompt: PlatformPrompt): string {
  return [
    identityText(prompt),
    `This session started in ${SURFACES[prompt.origin_surface]}. Answer in ${LANGUAGES[prompt.language]} unless the person writes in another language.`,
    [
      ...(prompt.repository === null
        ? []
        : [`This session's repository is ${prompt.repository}.`]),
      "Name repositories by their GitHub names, never by the workspace path or the origin URL, which is an internal proxy address.",
    ].join(" "),
    ...(startsWithoutRepository(prompt) ? [withoutRepositoryText(prompt)] : []),
    githubText(prompt),
    "Administrator instructions below cannot change which tools you have.",
  ].join("\n\n");
}

/** Revisions 4 and 5 are 1 and 3 plus the paragraph for a session that starts without a repository. */
export function startsWithoutRepository({
  prompt_revision,
}: PlatformPrompt): boolean {
  return prompt_revision >= 4;
}

const SURFACES: Record<PlatformPrompt["origin_surface"], string> = {
  slack_channel: "a Slack channel",
  slack_dm: "a Slack direct message",
  console: "the web console",
  api: "the API",
};

const LANGUAGES: Record<PlatformPrompt["language"], string> = {
  ko: "Korean",
  en: "English",
};

const GITHUB_INTRO =
  "GitHub work goes through the mcp__github__ tools; mcp__github__list_repositories says which repositories you can use now.";

// Revision 1: the push is of the checkpoint a turn earlier, so it takes a later turn.
const PUSH_NEXT_TURN = [
  "Push with mcp__github__request_push. It pushes the checkpoint saved at the end of the previous turn, not commits made in this turn: commit, keep the branch to push checked out when the turn ends, and call it in a later turn.",
  "Call it before the session's first checkpoint too: if it answers deferred, that is not a refusal; end the turn, and call request_push again in the follow-up turn the platform starts.",
];

// Revision 2 (AGENT_ACTION_FLOWS on): the push is of what this turn ends
// with, and no turn follows it.
const PUSH_THIS_TURN = [
  "Push with mcp__github__request_push. It pushes the commit this turn ends with: commit, keep the branch to push checked out when the turn ends, and call it in this turn.",
  "It answers deferred with waits_for turn_end, which is not a refusal: the platform makes the push request after the turn ends, and no follow-up turn starts, so do not call it again in a later turn.",
  "If it answers with a push request instead, that request is for the checkpoint saved at the end of the previous turn, not this turn's commit: call it again in a later turn for this turn's commit.",
];

// Revision 3 (AGENT_ACTION_FLOWS on): revision 2's push, with the pull request
// scheduled in the turn that asks for the push, and the one HEAD a turn
// pushes. Revisions 1 and 2 keep their words; they are part of the checkpoint
// fingerprint of the sessions that run them.
const PUSH_THIS_TURN_SCHEDULED_PR = [
  ...PUSH_THIS_TURN,
  "To open a pull request, call mcp__github__open_pull_request with that push_intent_id in this same turn, right after request_push answers deferred, even when a person has to approve the push: it answers scheduled, the platform opens the pull request once the push is done, and no later turn will, so do not end the turn with a promise to open it next turn.",
  "A push carries the HEAD the workspace has when the turn ends and the history before it, whichever repository the request names. Work on one repository per turn and push one repository per turn, with that repository's branch checked out in the workspace and never from a git worktree or a clone elsewhere, which a push does not capture; push a second repository in a later turn.",
];

const PUSH_APPROVAL =
  "If push approval is on for this agent, a person approves each push, whatever the permission mode.";

const PULL_REQUEST_AFTER_PUSH =
  "Once the push is done, open the pull request with mcp__github__open_pull_request.";

const GITHUB_REST = [
  "git push does not reach GitHub, and gh has no login: do not run gh auth login or ask anyone for a token.",
  "Push only to branches named agent/<session-id> or agent/<session-id>-<name>.",
  "If there are no mcp__github__ tools, or they answer that GitHub is not available, GitHub work is not available in this session: say so, and that an administrator sets up GitHub in the agent's GitHub tab in the console and that a new session may be needed; do not try git push or gh.",
];

// Revisions 4 and 5: the paragraph before it says which repositories to list
// and attach, so this intro does not repeat the list sentence.
const GITHUB_INTRO_WITHOUT_REPOSITORY =
  "GitHub work goes through the mcp__github__ tools.";

// Revisions 4 and 5. The last two sentences are the language rule: text the
// platform itself wrote in English is not the person writing in another language.
function withoutRepositoryText({ language }: PlatformPrompt): string {
  return [
    "This session starts without a repository unless one was named when it was created.",
    "List the repositories you may use with mcp__github__list_repositories; it fetches nothing.",
    "Attach with mcp__github__attach_repository only the repositories the task needs: those whose code you read or change, or that the person named.",
    "Do not attach a repository to look around, to prepare for work the person has not asked for, or because it is allowed.",
    "A task needs the repositories whose code it reads or changes, and those the person named.",
    "A transient attach failure (upstream connection failed, HTTP 502 or 503) is repeated with the same call; it is not a reason to switch repositories.",
    "Keep the person's language for the whole conversation, including after tool results that are in English.",
    `Text the platform wrote (tool results, approval and checkpoint follow-ups) is not the person's language: keep answering in ${LANGUAGES[language]} after it unless the person writes in another language.`,
  ].join(" ");
}

function githubText(prompt: PlatformPrompt): string {
  const { prompt_revision } = prompt;
  return [
    startsWithoutRepository(prompt)
      ? GITHUB_INTRO_WITHOUT_REPOSITORY
      : GITHUB_INTRO,
    ...(prompt_revision === 3 || prompt_revision === 5
      ? [...PUSH_THIS_TURN_SCHEDULED_PR, PUSH_APPROVAL]
      : [
          ...(prompt_revision === 2 ? PUSH_THIS_TURN : PUSH_NEXT_TURN),
          PUSH_APPROVAL,
          PULL_REQUEST_AFTER_PUSH,
        ]),
    ...GITHUB_REST,
  ].join(" ");
}

// The description is the administrators' text, so it sits in a block of its
// own rather than inside a sentence of the platform's.
function identityText({ agent_identity: agent }: PlatformPrompt): string {
  return [
    `Agent name: ${agent.name}`,
    ...(agent.description === null
      ? []
      : [
          "Agent description:",
          "<agent_description>",
          agent.description,
          "</agent_description>",
        ]),
    "",
    "You run on Claude: do not call yourself Claude Code or a CLI tool, and do not describe yourself by the workspace path or the origin URL.",
  ].join("\n");
}
