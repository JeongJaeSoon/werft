import {
  type ClaimGit,
  GITHUB_LOGIN_PATTERN,
  githubNoreplyEmail,
  type SessionGitHubAttribution,
} from "@werft-ai/contracts";
import type {
  SessionAttributionRecord,
  SessionAttributionStore,
} from "../action/ports/session-attribution.ts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import { requirePermitted, SessionServiceError } from "./session-service.ts";

/** The session's page in the console; null when the console has no origin. */
export function sessionUrlOf(
  consoleOrigin: string | null,
  sessionId: string,
): string | null {
  return consoleOrigin === null
    ? null
    : new URL(`/sessions/${sessionId}`, consoleOrigin).toString();
}

/**
 * The co-author a commit names, from the starter's GitHub link. Checked again
 * here, not trusted from the row: a value outside GitHub's own rules never
 * reaches a commit message.
 */
export function coAuthorOf(
  record: SessionAttributionRecord | null,
): { name: string; email: string } | null {
  return coAuthorOfLink(record?.starter?.github);
}

export function coAuthorOfLink(
  github: { id: string; login: string } | null | undefined,
): { name: string; email: string } | null {
  if (!github) return null;
  if (!/^[1-9][0-9]{0,19}$/.test(github.id)) return null;
  if (!GITHUB_LOGIN_PATTERN.test(github.login)) return null;
  return {
    name: github.login,
    email: githubNoreplyEmail(github.id, github.login),
  };
}

export type TailRequester =
  | { kind: "none" }
  | {
      kind: "person";
      github: { id: string; login: string } | null;
      surface: "Slack" | "web console" | "API key" | "platform";
    };

export function surfaceOfChannel(
  channel: "web" | "slack" | "api" | null,
): "Slack" | "web console" | "API key" | "platform" {
  return channel === "slack"
    ? "Slack"
    : channel === "web"
      ? "web console"
      : channel === "api"
        ? "API key"
        : "platform";
}

// No `@` before the login: GitHub would notify the person.
function requestedByValue(requester: TailRequester): string {
  if (requester.kind === "none") return "none (App only)";
  const who =
    coAuthorOfLink(requester.github)?.name ??
    "a person without a linked GitHub account";
  return `${who} (${requester.surface})`;
}

/**
 * The App's bot user as a commit author: `<slug>[bot]` with the noreply
 * address GitHub ties to that account (`<bot user id>+<slug>[bot]@users.
 * noreply.github.com`, the users API's id and login; see actions/checkout's
 * README). Null when either value falls outside GitHub's own rules.
 */
export function appBotAuthor(
  slug: string,
  botUserId: string,
): { name: string; email: string } | null {
  if (!/^[1-9][0-9]{0,19}$/.test(botUserId)) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,33}$/.test(slug)) return null;
  const login = `${slug}[bot]`;
  return { name: login, email: githubNoreplyEmail(botUserId, login) };
}

export function claimGitOf(
  record: SessionAttributionRecord | null,
  consoleOrigin: string | null,
  sessionId: string,
  sessionLink: "url" | "id" = "url",
): ClaimGit {
  return {
    co_author: coAuthorOf(record),
    // Null makes the worker's trailer name the session id.
    session_url:
      sessionLink === "id" ? null : sessionUrlOf(consoleOrigin, sessionId),
  };
}

export function attributionView(
  record: SessionAttributionRecord,
  last?: {
    userId: string | null;
    github: { id: string; login: string } | null;
  } | null,
): SessionGitHubAttribution {
  const coAuthor =
    last == null ? coAuthorOf(record) : coAuthorOfLink(last.github);
  const person = last == null ? record.starter !== null : last.userId !== null;
  return {
    trigger: record.trigger,
    attribution:
      coAuthor !== null ? "co_author" : !person ? "app_only" : "unlinked",
    login: coAuthor?.name ?? null,
  };
}

/** The session detail's attribution line; whoever may read the session. */
export function createSessionAttributionService(deps: {
  authorization: AuthorizationPolicy;
  store: Pick<SessionAttributionStore, "attribution" | "lastRequesterOf">;
}) {
  return {
    async get(
      caller: Caller,
      rawSessionId: string,
    ): Promise<SessionGitHubAttribution> {
      const sessionId = rawSessionId.toLowerCase();
      await requirePermitted(deps.authorization, caller, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const record = await deps.store.attribution(sessionId);
      if (record === null || record.ownerId !== caller.ownerId) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return attributionView(
        record,
        await deps.store.lastRequesterOf(sessionId),
      );
    },
  };
}

export type SessionAttributionService = ReturnType<
  typeof createSessionAttributionService
>;

/** Where the platform's part of a pull request body starts and ends. */
export const PULL_REQUEST_TAIL_MARKER = "<!-- werft:pr-tail -->";
export const PULL_REQUEST_TAIL_END_MARKER = "<!-- /werft:pr-tail -->";

/**
 * The hidden line naming the push request a pull request was opened for.
 * Anyone may write it into a body, so the drain only uses it to find a
 * candidate and still checks the repository, head, base and commit.
 */
export function pushRequestMarker(pushRequestId: string): string {
  return `<!-- agent-platform:push-request ${pushRequestId} -->`;
}

const PUSH_REQUEST_MARKER_LINE =
  /^<!-- agent-platform:push-request [A-Za-z0-9_-]{1,64} -->$/;

/** The push request id a body's marker names; the last one wins. */
export function pushRequestMarkerOf(body: string): string | null {
  let found: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (PUSH_REQUEST_MARKER_LINE.test(line.trimEnd())) {
      found = line.slice(
        "<!-- agent-platform:push-request ".length,
        -" -->".length,
      );
    }
  }
  return found;
}

/**
 * The pull request body's tail (decision 5): how to find the session again.
 * The body is anyone's to edit, so this is a pointer, never evidence.
 */
export function pullRequestTail(input: {
  sessionId: string;
  sessionUrl: string | null;
  /** `id` leaves the console link out; the session id is always there. */
  sessionLink?: "url" | "id";
  commit: string;
  pushRequestId: string;
  record: SessionAttributionRecord | null;
  /**
   * The turn that asked for this pull request. Its requester is the tail's
   * co-author; without it (a request no turn made) the starter is, and no
   * `Requested by` line is written.
   */
  requester?: TailRequester | null;
}): string {
  const { record } = input;
  const requester = input.requester ?? null;
  const starterCoAuthor = coAuthorOf(record);
  const coAuthor =
    requester === null
      ? starterCoAuthor
      : requester.kind === "person"
        ? coAuthorOfLink(requester.github)
        : null;
  // No `@` before the login: the tail must not notify the person.
  const starter =
    record === null
      ? "unknown"
      : starterCoAuthor !== null
        ? `GitHub account linked (${starterCoAuthor.name})`
        : record.starter === null
          ? "none (App only)"
          : "GitHub account not linked (App only)";
  const link =
    input.sessionUrl === null || input.sessionLink === "id"
      ? ""
      : ` · [session](<${input.sessionUrl}>)`;
  const lines = [
    "---",
    PULL_REQUEST_TAIL_MARKER,
    pushRequestMarker(input.pushRequestId),
    `Opened in a Werft session${link} · commit \`${input.commit.slice(0, 7)}\``,
    "",
    "<details><summary>Details</summary>",
    "",
    `- Session: \`${input.sessionId}\``,
    `- Agent: ${record?.agentId ? `\`${record.agentId}\`` : "none"}, release ${record?.agentReleaseId ? `\`${record.agentReleaseId}\`` : "none"}`,
    `- Push request: \`${input.pushRequestId}\``,
    `- Trigger: ${record?.trigger ?? "unknown"}`,
    `- Started by: ${starter}`,
    ...(requester === null
      ? []
      : [`- Requested by: ${requestedByValue(requester)}`]),
    "</details>",
    // Kept in the body: a squash merge's default message is the body, and
    // this line is what names the co-author there.
    ...(coAuthor === null
      ? []
      : ["", `Co-authored-by: ${coAuthor.name} <${coAuthor.email}>`]),
    PULL_REQUEST_TAIL_END_MARKER,
  ];
  return lines.join("\n");
}

type TailShape = {
  lines: readonly { line: RegExp; optional?: true }[];
  /** The `Started by` line that names a linked login, captured. */
  linked: RegExp;
  requested?: RegExp;
};

// What pullRequestTail writes between the markers, in order, now and before
// the folded tail; `optional` lines may be missing. Anything else there (a
// line a person added) is theirs.
const TAIL_SHAPES: readonly TailShape[] = [
  {
    lines: [
      // Absent from tails written before the drain.
      { line: PUSH_REQUEST_MARKER_LINE, optional: true },
      {
        line: /^Opened in a Werft session(?: · \[session\]\(<\S+>\))? · commit `[0-9a-f]{7}`$/,
      },
      { line: /^$/ },
      { line: /^<details><summary>Details<\/summary>$/ },
      { line: /^$/ },
      { line: /^- Session: `[^`]+`$/ },
      { line: /^- Agent: (`[^`]+`|none), release (`[^`]+`|none)$/ },
      { line: /^- Push request: `[^`]+`$/ },
      { line: /^- Trigger: [a-z_]+$/ },
      {
        line: /^- Started by: (unknown|none \(App only\)|GitHub account not linked \(App only\)|GitHub account linked \([A-Za-z0-9-]+\))$/,
      },
      // Reserved for the turn's requester, in the values the action
      // broker's caller mapping names; anything else there is a person's.
      {
        line: /^- Requested by: (?:[A-Za-z0-9-]+|a person without a linked GitHub account) \((?:Slack|web console|API key|platform)\)$|^- Requested by: none \(App only\)$/,
        optional: true,
      },
      { line: /^<\/details>$/ },
    ],
    linked: /^- Started by: GitHub account linked \(([A-Za-z0-9-]+)\)$/,
    requested:
      /^- Requested by: ([A-Za-z0-9-]+) \((?:Slack|web console|API key|platform)\)$/,
  },
  {
    lines: [
      // Pull requests opened before the rename still carry the old name.
      {
        line: /^Opened by (?:Werft|agent-platform) from session `[^`]+`, commit `[^`]+`\.$/,
      },
      { line: /^$/ },
      { line: /^- Session: \S+$/, optional: true },
      { line: /^- Agent: (`[^`]+`|none), release (`[^`]+`|none)$/ },
      { line: /^- Push request: `[^`]+`$/ },
      { line: /^- Trigger: [a-z_]+$/ },
      {
        line: /^- Started by: (unknown|none \(App only\)|GitHub account not linked \(App only\)|GitHub account linked \(@[A-Za-z0-9-]+\))$/,
      },
    ],
    linked: /^- Started by: GitHub account linked \(@([A-Za-z0-9-]+)\)$/,
  },
];
const TAIL_CO_AUTHOR =
  /^Co-authored-by: ([A-Za-z0-9-]+) <[1-9][0-9]*\+([A-Za-z0-9-]+)@users\.noreply\.github\.com>$/;

const QUOTING_ELEMENT =
  /<(\/?)(details|pre|div|table|blockquote|section|textarea|script|style)\b[^>]*>/gi;

/** Whether the lines between two markers are exactly a tail the platform wrote. */
function isTailContent(content: readonly string[]): boolean {
  const lines = content.map((line) => line.trimEnd());
  return TAIL_SHAPES.some((shape) => fitsShape(lines, shape));
}

function fitsShape(lines: readonly string[], shape: TailShape): boolean {
  let at = 0;
  let login: string | undefined;
  let requestedLogin: string | undefined;
  let requestedLine = false;
  for (const { line, optional } of shape.lines) {
    const next = lines[at];
    if (next !== undefined && line.test(next)) {
      login ??= shape.linked.exec(next)?.[1];
      if (next.startsWith("- Requested by: ")) {
        requestedLine = true;
        requestedLogin = shape.requested?.exec(next)?.[1];
      }
      at += 1;
    } else if (!optional) return false;
  }
  // The platform writes Co-authored-by exactly when the person it names is
  // linked, for that login; any other one is a person's. A tail with a
  // `Requested by` line names the requester; an older one, the starter.
  if (requestedLine) login = requestedLogin;
  if (login === undefined) return at === lines.length;
  const coAuthor = TAIL_CO_AUTHOR.exec(lines[at + 1] ?? "");
  return (
    at + 2 === lines.length &&
    lines[at] === "" &&
    coAuthor?.[1] === login &&
    coAuthor[2] === login
  );
}

/**
 * One line read left to right: whether it ends inside an HTML comment, given
 * whether it starts in one, and its text outside comments and code spans,
 * where elements still count. Inside a comment a backtick is text; a code
 * span closes only on a backtick run of its own length (CommonMark). Each cut
 * leaves a space, so pieces either side never join into a tag.
 */
function scanLine(
  line: string,
  inComment: boolean,
): { inComment: boolean; outside: string } {
  let outside = "";
  let at = 0;
  let inside = inComment;
  while (at < line.length) {
    if (inside) {
      const close = line.indexOf("-->", at);
      if (close === -1) return { inComment: true, outside };
      at = close + 3;
      inside = false;
      outside += " ";
      continue;
    }
    const next = /<!--|`+/g;
    next.lastIndex = at;
    const found = next.exec(line);
    if (found === null) break;
    outside += line.slice(at, found.index);
    at = found.index + found[0].length;
    if (found[0] === "<!--") {
      inside = true;
      continue;
    }
    const run = found[0];
    const closing = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
    closing.lastIndex = at;
    const end = closing.exec(line);
    // An unmatched run is literal backticks.
    if (end !== null) at = end.index + run.length;
    outside += " ";
  }
  return { inComment: inside, outside: outside + line.slice(at) };
}

/**
 * `body` with its tail replaced by `tail`. The tail is a start marker line
 * and the next end marker line, each alone and unindented on its line,
 * outside a fenced code block, an HTML comment and an HTML element such as
 * `<details>` (the tail's own `<details>` aside), with
 * only the platform's own lines between them; the last such pair is the one
 * replaced. Markers a person quotes are text. A body without such a pair
 * (from before the end marker, or one a person cut or edited) keeps all it
 * has and gets the tail added, after closing any block it leaves open. Text
 * around the tail is kept as written.
 */
export function withPullRequestTail(body: string, tail: string): string {
  // GitHub's editor saves CRLF. The result is cut from `body` at these
  // offsets, so the person's text keeps its own line endings.
  const lines = body.split(/\r?\n/);
  const starts = [0];
  for (const newline of body.matchAll(/\r?\n/g)) {
    starts.push(newline.index + newline[0].length);
  }
  const endOf = (at: number) => (starts[at] ?? 0) + (lines[at] ?? "").length;
  const blank = (at: number) => lines[at]?.trim() === "";
  // `body` up to the end of the last line before `at` that has text.
  const headBefore = (at: number) => {
    let last = at - 1;
    while (last >= 0 && blank(last)) last -= 1;
    return last < 0 ? "" : body.slice(0, endOf(last));
  };
  // The opening fence's run (CommonMark): only the same character, at least
  // as long, with nothing after it closes the block.
  let fence: string | null = null;
  // HTML elements a person opened around Markdown (`<details>` around a
  // pasted example): markers inside them are quoted.
  const open: string[] = [];
  // An HTML comment a person left open (`<!-- draft` with no end) hides
  // everything after it, a tail included.
  let inComment = false;
  let pair: [number, number] | null = null;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    if (
      !inComment &&
      fence === null &&
      open.length === 0 &&
      line.trimEnd() === PULL_REQUEST_TAIL_MARKER
    ) {
      // The tail holds its own `<details>`, so its lines are matched as a
      // whole before the element scan below can count them as quoted.
      // The platform writes its markers flush left; an indented one is
      // quoted (an indented code block, a list item).
      let end = at + 1;
      while (
        end < lines.length &&
        lines[end]?.trimEnd() !== PULL_REQUEST_TAIL_END_MARKER
      ) {
        end += 1;
      }
      if (end < lines.length && isTailContent(lines.slice(at + 1, end))) {
        pair = [at, end];
        at = end;
        continue;
      }
    }
    // A line that starts in a comment opens no fence.
    if (!inComment) {
      const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const marks = run?.[1] ?? "";
      const after = run?.[2] ?? "";
      if (fence !== null) {
        if (
          marks[0] === fence[0] &&
          marks.length >= fence.length &&
          /^[ \t]*$/.test(after)
        ) {
          fence = null;
        }
        continue;
      }
      // A backtick fence's info string has no backtick; that line is inline code.
      if (run && !(marks[0] === "`" && after.includes("`"))) {
        fence = marks;
        continue;
      }
    }
    const scanned = scanLine(line, inComment);
    inComment = scanned.inComment;
    for (const [, close, name] of scanned.outside.matchAll(QUOTING_ELEMENT)) {
      const tag = (name ?? "").toLowerCase();
      if (close === "") open.push(tag);
      else if (open.lastIndexOf(tag) !== -1) {
        open.splice(open.lastIndexOf(tag), 1);
      }
    }
  }
  if (pair === null) {
    // Closed first, or the tail lands inside the person's unclosed block and
    // is never found again: each refresh would add one more.
    const closing = [
      ...(inComment ? ["-->"] : []),
      ...(fence === null ? [] : [fence]),
      ...open.reverse().map((tag) => `</${tag}>`),
    ];
    const head = [headBefore(lines.length), ...closing]
      .filter((part) => part !== "")
      .join("\n");
    return head === "" ? tail : `${head}\n\n${tail}`;
  }
  const [from, to] = pair;
  // The marker follows the tail's own `---` line; keep the text above it.
  let top = from;
  while (top > 0 && blank(top - 1)) top -= 1;
  if (top > 0 && lines[top - 1]?.trim() === "---") top -= 1;
  const head = headBefore(top);
  let next = to + 1;
  while (next < lines.length && blank(next)) next += 1;
  const rest = next < lines.length ? body.slice(starts[next]) : "";
  return [head, tail, rest].filter((part) => part !== "").join("\n\n");
}

const NO_TAIL = "\u0000";

/**
 * `text` with any code fence or HTML element it leaves open closed, so text
 * placed after it is not swallowed. Uses the scan `withPullRequestTail` runs
 * on a body that has no tail, with a placeholder in the tail's place.
 */
export function closeOpenBlocks(text: string): string {
  const closed = withPullRequestTail(text, NO_TAIL);
  return closed === NO_TAIL ? "" : closed.slice(0, -(NO_TAIL.length + 2));
}
