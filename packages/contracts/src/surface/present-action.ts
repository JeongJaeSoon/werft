import { MCP_TOOL_PREFIX } from "../kollegium/agents.ts";

/*
 * Says in words what a request waiting for a person is, for every surface
 * that asks (the web approval card and push screen, Slack). Like
 * presentTurnEvent it returns message keys and parameters, not text: each
 * surface owns its wording. Free of zod and of I/O, so a browser bundle can
 * call it; whether a push may be approved needs the checkpoint store, so that
 * verdict is made in the platform and only turned into words here.
 */

export const TOOL_VERB_VALUES = [
  "runCommand",
  "editFile",
  "writeFile",
  "readFile",
  "findFiles",
  "searchContents",
  "readWebPage",
  "searchWeb",
  "requestPush",
  "openPullRequest",
  "updatePullRequest",
  "commentPullRequest",
  "closePullRequest",
  "reopenPullRequest",
  "attachRepository",
  "useTool",
  "useMcpTool",
] as const;
export type ToolVerb = (typeof TOOL_VERB_VALUES)[number];

export type ToolVerbKey = `action.tool.${ToolVerb}`;

export interface ToolVerbMessage {
  readonly key: ToolVerbKey;
  /** `useTool`: `tool`. `useMcpTool`: `server` and `tool`. */
  readonly params?: Readonly<Record<string, string>> | undefined;
}

/** What a tool's input points at, read from the platform's own rows. */
export interface ToolRequestContext {
  readonly repository?: string | undefined;
  readonly branch?: string | undefined;
}

/**
 * `target`: what the tool acts on. `excerpt`: the first lines of what a file
 * tool writes, so a person sees the content without opening the raw input.
 */
export interface ToolRequestPresentation {
  readonly verb: ToolVerbMessage;
  readonly target: string | null;
  readonly excerpt: string | null;
}

const TARGET_MAX = 200;
const COMMAND_MAX = 120;
const URL_PATH_MAX = 40;
const EXCERPT_LINES = 3;
const EXCERPT_MAX = 300;
const GITHUB = `${MCP_TOOL_PREFIX}github__`;

const clip = (value: string, max: number) => {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
};

/** At most EXCERPT_MAX characters, a trailing "…" line when there is more. */
function excerptOf(text: string | null): string | null {
  if (text === null) return null;
  const lines = text.split("\n");
  const more = lines.length > EXCERPT_LINES;
  const head = clip(
    lines
      .slice(0, EXCERPT_LINES)
      .map((line) => clip(line, COMMAND_MAX))
      .join("\n"),
    more ? EXCERPT_MAX - 2 : EXCERPT_MAX,
  );
  return more && !head.endsWith("…") ? `${head}\n…` : head;
}

/** A string field as written, whitespace kept; null when blank. */
function content(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** An edit's new text; the first of several, with "…" for the rest. */
function editedText(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const edits = (input as { edits?: unknown }).edits;
  if (!Array.isArray(edits)) return content(input, "new_string");
  const first = content(edits[0], "new_string");
  return first !== null && edits.length > 1 ? `${first}\n…` : first;
}

function field(input: unknown, key: string): string | null {
  return content(input, key)?.trim() ?? null;
}

function firstLine(text: string | null): string | null {
  const line = text?.split("\n").find((part) => part.trim() !== "");
  return line === undefined ? null : clip(line.trim(), COMMAND_MAX);
}

function webTarget(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${clip(path, URL_PATH_MAX)}`;
  } catch {
    return null;
  }
}

/** `repository ← branch`, either side left out when unknown. */
function headOf(context: ToolRequestContext): string | null {
  const parts = [context.repository, context.branch].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return parts.length === 0 ? null : parts.join(" ← ");
}

const verb = (name: ToolVerb, params?: Record<string, string>) =>
  ({
    key: `action.tool.${name}`,
    ...(params === undefined ? {} : { params }),
  }) satisfies ToolVerbMessage;

/** Null when the tool is no GitHub tool or nothing about it could be read. */
function githubPresentation(
  tool: string,
  input: unknown,
  context: ToolRequestContext,
): { verb: ToolVerbMessage; target: string } | null {
  if (!tool.startsWith(GITHUB)) return null;
  const head = headOf(context);
  const onHead = (name: ToolVerb) =>
    head === null ? null : { verb: verb(name), target: head };
  switch (tool.slice(GITHUB.length)) {
    case "request_push":
      return onHead("requestPush");
    case "open_pull_request": {
      const title = field(input, "title");
      const target =
        title === null ? head : head === null ? title : `${title} (${head})`;
      return target === null ? null : { verb: verb("openPullRequest"), target };
    }
    case "update_pull_request":
      return onHead("updatePullRequest");
    case "comment_pull_request":
      return onHead("commentPullRequest");
    case "close_pull_request":
      return onHead("closePullRequest");
    case "reopen_pull_request":
      return onHead("reopenPullRequest");
    case "attach_repository":
      return context.repository === undefined
        ? null
        : {
            verb: verb("attachRepository"),
            target: context.repository,
          };
    default:
      return null;
  }
}

/**
 * The plain-words line a card shows over a tool's raw input: what the tool
 * does and what it does it to. It helps a person decide; the raw input
 * still goes with it, folded. Never throws.
 */
export function presentPendingRequest(
  tool: string,
  input: unknown,
  context: ToolRequestContext = {},
): ToolRequestPresentation {
  const of = (
    name: ToolVerb,
    target: string | null,
    excerpt: string | null = null,
  ): ToolRequestPresentation => ({
    verb: verb(name),
    target: target === null ? null : clip(target, TARGET_MAX),
    excerpt: excerptOf(excerpt),
  });
  switch (tool) {
    case "Bash":
      return of(
        "runCommand",
        firstLine(field(input, "description") ?? field(input, "command")),
      );
    case "Edit":
    case "MultiEdit":
      return of("editFile", field(input, "file_path"), editedText(input));
    case "NotebookEdit":
      return of(
        "editFile",
        field(input, "notebook_path"),
        content(input, "new_source"),
      );
    case "Write":
      return of(
        "writeFile",
        field(input, "file_path"),
        content(input, "content"),
      );
    case "Read":
      return of("readFile", field(input, "file_path"));
    case "Glob":
      return of("findFiles", field(input, "pattern"));
    case "Grep":
      return of("searchContents", field(input, "pattern"));
    case "WebFetch":
      return of("readWebPage", webTarget(field(input, "url")));
    case "WebSearch":
      return of("searchWeb", field(input, "query"));
  }
  const github = githubPresentation(tool, input, context);
  if (github !== null) {
    return {
      verb: github.verb,
      target: clip(github.target, TARGET_MAX),
      excerpt: null,
    };
  }
  if (tool.startsWith(MCP_TOOL_PREFIX)) {
    const rest = tool.slice(MCP_TOOL_PREFIX.length);
    const split = rest.indexOf("__");
    if (split > 0 && split < rest.length - 2) {
      return {
        verb: verb("useMcpTool", {
          server: rest.slice(0, split),
          tool: rest.slice(split + 2),
        }),
        target: null,
        excerpt: null,
      };
    }
  }
  return { verb: verb("useTool", { tool }), target: null, excerpt: null };
}

/** Why a push waiting for approval cannot be approved now. */
export const PUSH_UNAPPROVABLE_REASON_VALUES = [
  "not_requested",
  "checkpoint_moved",
  "pinned_source_invalid",
] as const;
export type PushUnapprovableReason =
  (typeof PUSH_UNAPPROVABLE_REASON_VALUES)[number];

export type PushApprovabilityVerdict =
  | { readonly approvable: true }
  | { readonly approvable: false; readonly reason: PushUnapprovableReason };

export type PushUnapprovableMessageKey =
  `action.push.unapprovable.${PushUnapprovableReason}`;

/** `reason` is null exactly when the push can be approved. */
export interface PushRequestPresentation {
  readonly approvable: boolean;
  readonly reason: { readonly key: PushUnapprovableMessageKey } | null;
}

export function presentPushRequest(
  verdict: PushApprovabilityVerdict,
): PushRequestPresentation {
  return verdict.approvable
    ? { approvable: true, reason: null }
    : {
        approvable: false,
        reason: { key: `action.push.unapprovable.${verdict.reason}` },
      };
}
