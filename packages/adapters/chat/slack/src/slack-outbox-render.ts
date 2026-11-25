import { DEFAULT_USER_LOCALE, type UserLocale } from "@werft-ai/contracts";
import type {
  SurfaceOutboxClaim,
  SurfaceOutboxEntry,
  SurfaceUnpostedInstruction,
} from "@werft-ai/platform";
import { markdownToSlackMrkdwn, markdownToSlackParts } from "./slack-mrkdwn.ts";
import {
  escapeSlackControls,
  isSafeLink,
  mapCodeAndText,
} from "./slack-presentation.ts";

/** chat.postMessage truncates `text` past this many characters. */
export const SLACK_TEXT_MAX = 40_000;

export const SLACK_OUTBOX_MESSAGES: Readonly<
  Record<
    UserLocale,
    Readonly<
      Record<"emptyReply" | "uncertain" | "link" | "web" | "api", string>
    >
  >
> = {
  ko: {
    emptyReply: "답변을 마쳤어요. 내용은 웹에서 확인해 주세요",
    uncertain: "답을 보냈는지 확인하지 못했어요. 웹에서 확인해 주세요",
    link: "웹에서 열기",
    web: "웹 콘솔",
    api: "API",
  },
  ja: {
    emptyReply: "回答が完了しました。内容はWebで確認してください",
    uncertain: "回答を送信できたか確認できませんでした。Webで確認してください",
    link: "Webで開く",
    web: "Webコンソール",
    api: "API",
  },
  en: {
    emptyReply: "The answer is done. See it on the web",
    uncertain: "We couldn't confirm the answer was sent. Check it on the web",
    link: "Open on the web",
    web: "Web console",
    api: "API",
  },
};

/** Slack cuts a `username` past this many characters. */
const SLACK_USERNAME_MAX = 80;

/**
 * Who an instruction came from, as its `username`; an app that cannot set
 * the name puts it on the text's first line instead.
 */
export function slackInstructionSender(
  channel: SurfaceUnpostedInstruction["channel"],
  senderName: string | null,
  locale: UserLocale,
): string {
  const via = SLACK_OUTBOX_MESSAGES[locale][channel];
  const name = senderName?.replace(/\s+/g, " ").trim();
  if (!name) return via;
  const suffix = ` (${via})`;
  return `${[...name].slice(0, SLACK_USERNAME_MAX - suffix.length).join("")}${suffix}`;
}

/**
 * What goes to Slack: the body's Markdown as mrkdwn with every control
 * escaped, cut to fit with its link kept whole after it.
 */
function outboxLink(body: SurfaceOutboxEntry["body"]): string {
  return body.link_url !== undefined && isSafeLink(body.link_url)
    ? `<${body.link_url}|${SLACK_OUTBOX_MESSAGES[body.locale ?? DEFAULT_USER_LOCALE].link}>`
    : "";
}

function outboxEscaper(body: SurfaceOutboxEntry["body"]) {
  return (value: string) =>
    escapeSlackControls(value, {
      maskedLinks: "expand",
      ...(body.mention_user_ids === undefined
        ? {}
        : { userIds: body.mention_user_ids }),
    });
}

// A section's text may not pass 3000 characters, and a message holds 50 blocks.
const SECTION_TEXT_MAX = 3_000;

/** Whole lines, each piece within the section limit; null when that cannot be. */
function sectionPieces(text: string): string[] | null {
  const pieces: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > SECTION_TEXT_MAX) return null;
    if (current !== "" && current.length + line.length + 1 > SECTION_TEXT_MAX) {
      pieces.push(current);
      current = line;
    } else current = current === "" ? line : `${current}\n${line}`;
  }
  pieces.push(current);
  // A cut inside a code fence would leave both halves unclosed.
  return pieces.every((piece) => piece.split("```").length % 2 === 1)
    ? pieces
    : null;
}

/**
 * The reply as Slack blocks when it holds a table that fits a table block:
 * the text around it in sections, the table, then the link. Null when the
 * reply has no such table or a piece cannot fit; the plain text then carries
 * the table as one line per row.
 */
export function slackReplyBlocks(
  body: SurfaceOutboxEntry["body"],
): unknown[] | null {
  const parts = markdownToSlackParts(body.text);
  if (parts === null) return null;
  const escaped = outboxEscaper(body);
  const blocks: unknown[] = [];
  for (const part of parts) {
    if ("table" in part) {
      blocks.push({
        type: "table",
        column_settings: part.table.rows[0]?.map(() => ({ is_wrapped: true })),
        rows: part.table.rows.map((row) =>
          row.map((text) => ({ type: "raw_text", text })),
        ),
      });
      continue;
    }
    const pieces = sectionPieces(escaped(part.text));
    if (pieces === null) return null;
    for (const text of pieces) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text } });
    }
  }
  const link = outboxLink(body);
  if (link !== "") {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: link } });
  }
  return blocks.length <= 50 ? blocks : null;
}

export function slackOutboxText(body: SurfaceOutboxEntry["body"]): string {
  const link = outboxLink(body) === "" ? "" : `\n\n${outboxLink(body)}`;
  const escaped = outboxEscaper(body);
  // Converted before the cut: the loop below re-escapes pieces of this text.
  const text = escaped(markdownToSlackMrkdwn(body.text));
  const room = SLACK_TEXT_MAX - link.length - 1;
  if (text.length <= room + 1) return text + link;
  let piece = text;
  let cut = room;
  while (piece.length > room) {
    // Not inside an escape such as `&lt;`, nor between a surrogate pair.
    const amp = text.lastIndexOf("&", cut);
    if (amp !== -1 && amp > cut - 6 && !text.slice(amp, cut).includes(";")) {
      cut = amp;
    }
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    // A cut can open a code fence whose close fell away, and Slack shows an
    // unclosed fence as plain text: what it held must be escaped too.
    piece = escaped(text.slice(0, cut));
    cut -= piece.length - room;
  }
  return `${piece}…${link}`;
}

export function sessionUrl(consoleOrigin: string | null, sessionId: string) {
  return consoleOrigin === null
    ? undefined
    : new URL(`/sessions/${sessionId}`, consoleOrigin).toString();
}

export function slackOutboxPresentation(
  claim: Pick<SurfaceOutboxClaim, "kind" | "body">,
):
  | {
      kind: "instruction";
      sender: NonNullable<SurfaceOutboxEntry["body"]["sender"]>;
    }
  | { kind: "blocks"; blocks: unknown[]; fallback: boolean }
  | { kind: "text" } {
  const sender = claim.body.sender;
  if (
    (claim.kind === "instruction" || claim.kind === "input_mirror") &&
    sender !== undefined
  ) {
    return { kind: "instruction", sender };
  }
  if (claim.body.blocks !== undefined) {
    return { kind: "blocks", blocks: claim.body.blocks, fallback: false };
  }
  const blocks = claim.kind === "reply" ? slackReplyBlocks(claim.body) : null;
  return blocks === null
    ? { kind: "text" }
    : { kind: "blocks", blocks, fallback: true };
}

// Group notifications as Slack controls, and the bare words an app could
// have Slack turn into them. The agent never calls a whole channel or group.
const GROUP_CONTROL =
  /(^|[ \t]+)?(?:<!(?:here|channel|everyone)(?:\|[^<>\n]*)?>|<!subteam\^[^<>\n]*>)([ \t]+)?/gim;
const GROUP_WORD =
  /(^|[ \t]+)?(?<![\w@.])@(?:here|channel|everyone)\b([ \t]+)?/gim;

// One space stays where the mention stood between two words.
const dropSpaced = (_: string, before?: string, after?: string) =>
  before && after ? " " : "";

/**
 * The text without group mentions (G7), outside code: code shows them as
 * written and escaped, so they notify no one there.
 */
export function stripSlackGroupMentions(text: string): string {
  return mapCodeAndText(
    text,
    (part) =>
      part.replace(GROUP_CONTROL, dropSpaced).replace(GROUP_WORD, dropSpaced),
    (code) => code,
  );
}

/** The one channel, in its team, a row's text may link to or name. */
export type SlackOutboxScope = { teamId: string; channelId: string };

/**
 * The parent conversation's channel; a DM's is the row's own DM channel. A
 * row with no conversation, or one sent outside it, has none.
 */
export function slackOutboxScope(
  claim: Pick<SurfaceOutboxClaim, "channelId" | "conversationScope">,
): SlackOutboxScope | null {
  const scope = claim.conversationScope;
  if (scope == null) return null;
  const channelId =
    scope.kind === "channel"
      ? scope.channelId
      : claim.channelId.startsWith("D")
        ? claim.channelId
        : null;
  return channelId === null ? null : { teamId: scope.teamId, channelId };
}

function isSlackUrl(url: URL): boolean {
  return (
    url.protocol === "slack:" ||
    url.hostname === "slack.com" ||
    url.hostname.endsWith(".slack.com")
  );
}

/**
 * The channel and team ids a Slack URL names in its path or query
 * (`/archives/C…`, `/client/T…/C…`, `?team=T…&id=C…`); empty for any other URL.
 */
function slackUrlRefs(raw: string): { channels: string[]; teams: string[] } {
  const refs = { channels: [] as string[], teams: [] as string[] };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refs;
  }
  if (!isSlackUrl(url)) return refs;
  const values = [...url.pathname.split("/"), ...url.searchParams.values()];
  for (const value of values) {
    if (/^[CGD][A-Z0-9]+$/.test(value)) refs.channels.push(value);
    else if (/^[TE][A-Z0-9]+$/.test(value)) refs.teams.push(value);
  }
  return refs;
}

// A Markdown link, a Slack control, a bare URL, or a bare channel id shaped
// as Slack makes them (a digit among 8 to 11 more capitals and digits).
const SLACK_REFERENCE =
  /\[[^\]\n]*\]\(\s*<?([^()\s<>]+)>?\s*\)|<([^<>\n]+)>|((?:https?|slack):\/\/[^\s<>()[\]|"'`]+)|\b([CGD](?=[A-Z0-9]*\d)[A-Z0-9]{8,11})\b/g;

/**
 * The text without the Slack links and channel ids outside its scope (A3),
 * and the ids that were outside. A stopgap only: a leak written out in words
 * passes; the scope's isolation is what keeps a conversation's own.
 */
export function dropOutOfScopeSlackRefs(
  text: string,
  scope: SlackOutboxScope | null,
): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const outside = (channels: string[], teams: string[]) => {
    const out = [
      ...channels.filter((id) => id !== scope?.channelId),
      ...teams.filter((id) => id !== scope?.teamId),
    ];
    dropped.push(...out);
    return out.length > 0;
  };
  const outsideUrl = (url: string) => {
    const { channels, teams } = slackUrlRefs(url);
    return outside(channels, teams);
  };
  const kept = text.replace(
    SLACK_REFERENCE,
    (
      whole,
      markdownUrl?: string,
      control?: string,
      bare?: string,
      id?: string,
    ) => {
      if (markdownUrl !== undefined)
        return outsideUrl(markdownUrl) ? "" : whole;
      if (control !== undefined) {
        const target = control.split("|", 1)[0] ?? "";
        if (target.startsWith("#")) {
          return outside([target.slice(1)], []) ? "" : whole;
        }
        return outsideUrl(target) ? "" : whole;
      }
      if (bare !== undefined) {
        // A sentence's full stop is not the URL's.
        const url = bare.replace(/[.,;:!?]+$/, "");
        return outsideUrl(url) ? bare.slice(url.length) : whole;
      }
      return id !== undefined && outside([id], []) ? "" : whole;
    },
  );
  return { text: kept, dropped };
}

/**
 * The body as it may go out: no group mention, and, past a person's own
 * words (an instruction or its mirror), no Slack reference outside the row's
 * conversation. A card's blocks and text are its own, escaped already.
 */
export function guardSlackOutboxBody(
  claim: Pick<
    SurfaceOutboxClaim,
    "kind" | "body" | "channelId" | "conversationScope"
  >,
): { body: SurfaceOutboxEntry["body"]; dropped: string[] } {
  const { body } = claim;
  if (body.blocks !== undefined) return { body, dropped: [] };
  const text = stripSlackGroupMentions(body.text);
  if (claim.kind === "instruction" || claim.kind === "input_mirror") {
    return { body: { ...body, text }, dropped: [] };
  }
  const scoped = dropOutOfScopeSlackRefs(text, slackOutboxScope(claim));
  return { body: { ...body, text: scoped.text }, dropped: scoped.dropped };
}

export function slackInstructionFallbackText(
  body: SurfaceOutboxEntry["body"],
  text: string,
  username: string,
): string {
  const named = `${username}\n`;
  return body.text.startsWith(named)
    ? text
    : slackOutboxText({ ...body, text: named + body.text });
}
