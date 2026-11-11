import { DEFAULT_USER_LOCALE, type UserLocale } from "@werft-ai/contracts";
import type {
  SlackOutboxClaim,
  SlackOutboxEntry,
  SlackUnpostedInstruction,
} from "@werft-ai/platform";
import { markdownToSlackMrkdwn, markdownToSlackParts } from "./slack-mrkdwn.ts";
import { escapeSlackControls } from "./slack-presentation.ts";

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
  channel: SlackUnpostedInstruction["channel"],
  senderName: string | null,
  locale: UserLocale,
): string {
  const via = SLACK_OUTBOX_MESSAGES[locale][channel];
  const name = senderName?.replace(/\s+/g, " ").trim();
  if (!name) return via;
  const suffix = ` (${via})`;
  return `${[...name].slice(0, SLACK_USERNAME_MAX - suffix.length).join("")}${suffix}`;
}

function isSafeLink(url: string): boolean {
  if (/[<>|\s]/.test(url)) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * What goes to Slack: the body's Markdown as mrkdwn with every control
 * escaped, cut to fit with its link kept whole after it.
 */
function outboxLink(body: SlackOutboxEntry["body"]): string {
  return body.link_url !== undefined && isSafeLink(body.link_url)
    ? `<${body.link_url}|${SLACK_OUTBOX_MESSAGES[body.locale ?? DEFAULT_USER_LOCALE].link}>`
    : "";
}

function outboxEscaper(body: SlackOutboxEntry["body"]) {
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
  body: SlackOutboxEntry["body"],
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

export function slackOutboxText(body: SlackOutboxEntry["body"]): string {
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
  claim: Pick<SlackOutboxClaim, "kind" | "body">,
):
  | {
      kind: "instruction";
      sender: NonNullable<SlackOutboxEntry["body"]["sender"]>;
    }
  | { kind: "blocks"; blocks: unknown[]; fallback: boolean }
  | { kind: "text" } {
  const sender = claim.body.sender;
  if (claim.kind === "instruction" && sender !== undefined) {
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

export function slackInstructionFallbackText(
  body: SlackOutboxEntry["body"],
  text: string,
  username: string,
): string {
  const named = `${username}\n`;
  return body.text.startsWith(named)
    ? text
    : slackOutboxText({ ...body, text: named + body.text });
}
