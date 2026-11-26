import { DEFAULT_USER_LOCALE, type UserLocale } from "@werft-ai/contracts";
import type {
  SurfaceAiLabel,
  SurfaceOutboxClaim,
  SurfaceOutboxEntry,
  SurfaceOutboxKind,
  SurfaceOutboxPostedAs,
  SurfaceUnpostedInstruction,
} from "@werft-ai/platform";
import { slackAiLabelBlock, slackAiLabelMrkdwn } from "./slack-ai-label.ts";
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
 * The name the agent's own row goes out under: "agent [task]" for a task,
 * the agent alone otherwise. A title too long to fit is cut inside its
 * brackets; a name too long for one is cut alone. Null with no name.
 */
export function slackAgentSender(
  postedAs: SurfaceOutboxPostedAs | null | undefined,
): string | null {
  const oneLine = (value: string | null | undefined) => [
    ...(value?.replace(/\s+/g, " ").trim() ?? ""),
  ];
  const name = oneLine(postedAs?.agentName);
  if (name.length === 0) return null;
  const title = oneLine(postedAs?.taskTitle);
  // " [" and "]" around the title, and "…" when it is cut.
  const room = SLACK_USERNAME_MAX - name.length - 3;
  // A cut title needs room for one character and its "…".
  if (title.length === 0 || (title.length > room && room < 2)) {
    return name.slice(0, SLACK_USERNAME_MAX).join("");
  }
  const shown =
    title.length <= room ? title : [...title.slice(0, room - 1), "…"];
  return `${name.join("")} [${shown.join("")}]`;
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

/** A last pass over the text as Slack will read it, before escaping. */
export type SlackTextGuard = (text: string) => string;

function outboxEscaper(
  body: SurfaceOutboxEntry["body"],
  guard: SlackTextGuard = (text) => text,
) {
  return (value: string) =>
    escapeSlackControls(guard(value), {
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
  guard: SlackTextGuard = (text) => text,
): unknown[] | null {
  const parts = markdownToSlackParts(body.text);
  if (parts === null) return null;
  const escaped = outboxEscaper(body, guard);
  const blocks: unknown[] = [];
  for (const part of parts) {
    if ("table" in part) {
      blocks.push({
        type: "table",
        column_settings: part.table.rows[0]?.map(() => ({ is_wrapped: true })),
        rows: part.table.rows.map((row) =>
          row.map((text) => ({ type: "raw_text", text: guard(text) })),
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

export function slackOutboxText(
  body: SurfaceOutboxEntry["body"],
  guard?: SlackTextGuard,
  // Room kept for what the caller adds after, so the cut never drops it.
  reserve = 0,
): string {
  const link = outboxLink(body) === "" ? "" : `\n\n${outboxLink(body)}`;
  const escaped = outboxEscaper(body, guard);
  // Converted before the cut: the loop below re-escapes pieces of this text.
  const text = escaped(markdownToSlackMrkdwn(body.text));
  const room = SLACK_TEXT_MAX - link.length - 1 - reserve;
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

/**
 * Whether a kind goes out as the agent's own words, and so ends with the AI
 * line. An instruction and its mirror are a person's words under their name,
 * and a reaction is no post. A new kind has to say.
 */
export const SLACK_AI_LABELLED_KINDS: Readonly<
  Record<SurfaceOutboxKind, boolean>
> = {
  instruction: false,
  reply: true,
  notice: true,
  failure_notice: true,
  input_notice: true,
  welcome: true,
  action_notice: true,
  model_notice: true,
  input_mirror: false,
  channel_notice: true,
  progress: true,
  reaction: false,
  conversation_reply: true,
};

/**
 * The line a row ends with. `read` is what the store read for it, absent
 * while the agent's rollout is not `on`; a conversation's answer, which only
 * exists under `on`, always has one and carries its own name.
 */
export function slackOutboxAiLabel(
  claim: Pick<SurfaceOutboxClaim, "kind" | "body">,
  read?: SurfaceAiLabel,
): SurfaceAiLabel | undefined {
  if (claim.kind === "conversation_reply") {
    return { requestedBy: claim.body.requested_by ?? null };
  }
  return SLACK_AI_LABELLED_KINDS[claim.kind] ? read : undefined;
}

/** The blocks with the AI line last; as they are without one. */
export function withSlackAiLabel(
  blocks: unknown[],
  locale: UserLocale | undefined,
  label: SurfaceAiLabel | undefined,
): unknown[] {
  return label === undefined
    ? blocks
    : [...blocks, slackAiLabelBlock(locale, label.requestedBy ?? undefined)];
}

/** The line as a post's text takes it after its own words; "" without one. */
export function slackAiLabelSuffix(
  locale: UserLocale | undefined,
  label: SurfaceAiLabel | undefined,
): string {
  return label === undefined ? "" : `\n\n${slackAiLabelMrkdwn(locale)}`;
}

export function slackOutboxPresentation(
  claim: Pick<SurfaceOutboxClaim, "kind" | "body">,
  guard?: SlackTextGuard,
  label?: SurfaceAiLabel,
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
  const { locale } = claim.body;
  // A card's own blocks are far under a message's 50, the line included.
  if (claim.body.blocks !== undefined) {
    return {
      kind: "blocks",
      blocks: withSlackAiLabel(claim.body.blocks, locale, label),
      fallback: false,
    };
  }
  const table =
    claim.kind === "reply" || claim.kind === "conversation_reply"
      ? slackReplyBlocks(claim.body, guard)
      : null;
  if (label === undefined) {
    return table === null
      ? { kind: "text" }
      : { kind: "blocks", blocks: table, fallback: true };
  }
  // The text, then the AI line; too big for blocks, the text carries both.
  const said =
    table ??
    sectionPieces(slackOutboxText(claim.body, guard))?.map((text) => ({
      type: "section",
      text: { type: "mrkdwn", text },
    })) ??
    null;
  return said === null || said.length >= 50
    ? { kind: "text" }
    : {
        kind: "blocks",
        blocks: withSlackAiLabel(said, locale, label),
        fallback: true,
      };
}

// Group notifications as Slack controls, and the bare words an app could
// have Slack turn into them. The agent never calls a whole channel or group.
const GROUP_CONTROL =
  /(^|[ \t]+)?(?:<!(?:here|channel|everyone)(?:\|[^<>\n]*)?>|<!subteam\^[^<>\n]*>)([ \t]+)?/gim;
const GROUP_WORD =
  /(^|[ \t]+)?(?<![A-Za-z0-9@.])@(?:here|channel|everyone)(?![A-Za-z0-9])([ \t]+)?/gim;

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

const CHANNEL_ID_IN_TEXT =
  /(?<![A-Za-z0-9])[CGD](?=[A-Z0-9]*\d)[A-Z0-9]{8,11}(?![A-Za-z0-9])/g;

// A Slack id as Slack makes them: its kind's capital, then capitals and
// digits with a digit among them. Links may write it in either case.
const channelIdOf = (value: string) =>
  /^[CGD](?=[A-Z0-9]*\d)[A-Z0-9]+$/i.test(value) ? value.toUpperCase() : null;
const teamIdOf = (value: string) =>
  /^[TE](?=[A-Z0-9]*\d)[A-Z0-9]+$/i.test(value) ? value.toUpperCase() : null;

function parsedUrl(raw: string): URL | null {
  for (const candidate of raw.includes("://") ? [raw] : [`https://${raw}`]) {
    try {
      return new URL(candidate);
    } catch {}
  }
  return null;
}

// Each well-formed %XX, as often as it was encoded; a malformed one stays
// as written and keeps none of the others from decoding.
function decoded(value: string): string {
  let text = value;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * The channel and team ids a Slack URL names in its path or query
 * (`/archives/C…`, `/client/T…/C…`, `?team=T…&id=C…`), percent-encoded
 * or not; empty for any other URL.
 */
function slackUrlRefs(raw: string): { channels: string[]; teams: string[] } {
  const refs = { channels: [] as string[], teams: [] as string[] };
  // Any link, a fragment included, can carry an id as bare text would, and
  // one that does not parse still shows it.
  refs.channels = decoded(raw).match(CHANNEL_ID_IN_TEXT) ?? [];
  const url = parsedUrl(raw);
  if (url === null) return refs;
  const values = [
    ...url.pathname.split("/").map(decoded),
    ...url.searchParams.values(),
  ];
  if (!isSlackUrl(url)) return refs;
  for (const value of values) {
    const channel = channelIdOf(value);
    const team = channel === null ? teamIdOf(value) : null;
    if (channel !== null) refs.channels.push(channel);
    if (team !== null) refs.teams.push(team);
  }
  refs.channels = [...new Set(refs.channels)];
  return refs;
}

// A Markdown link, a Slack control, a URL (any scheme, or a Slack host Slack
// links without one), or a bare channel id.
const SLACK_REFERENCE =
  /\[([^\]\n]*)\]\(\s*<?([^()\s<>]+)>?\s*\)|<([^<>\n]+)>|((?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\b(?:[A-Za-z0-9-]+\.)*slack\.com\/)[^\s<>()[\]|"'`]*)|(?<![A-Za-z0-9])([CGD](?=[A-Z0-9]*\d)[A-Z0-9]{8,11})(?![A-Za-z0-9])/gi;

/**
 * The text without the Slack links and channel ids outside its scope (A3),
 * and the ids that were outside. A link goes whole when its label holds one
 * too. A stopgap only: a leak written out in words passes; the scope's
 * isolation is what keeps a conversation's own.
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
  const outsideLabel = (label: string) => {
    const inner = dropOutOfScopeSlackRefs(label, scope).dropped;
    dropped.push(...inner);
    return inner.length > 0;
  };
  const kept = text.replace(
    SLACK_REFERENCE,
    (
      whole,
      markdownLabel?: string,
      markdownUrl?: string,
      control?: string,
      bare?: string,
      id?: string,
    ) => {
      if (markdownUrl !== undefined) {
        const out = outsideUrl(markdownUrl);
        return outsideLabel(markdownLabel ?? "") || out ? "" : whole;
      }
      if (control !== undefined) {
        const bar = control.indexOf("|");
        const target = bar === -1 ? control : control.slice(0, bar);
        // Anything else in brackets is read as text: a bare id there too.
        const out = target.startsWith("#")
          ? outside([target.slice(1).toUpperCase()], [])
          : target.includes("://")
            ? outsideUrl(target)
            : outsideLabel(target);
        const label = bar === -1 ? "" : control.slice(bar + 1);
        return outsideLabel(label) || out ? "" : whole;
      }
      if (bare !== undefined) {
        // A sentence's full stop is not the URL's.
        const url = bare.replace(/[.,;:!?]+$/, "");
        return outsideUrl(url) ? bare.slice(url.length) : whole;
      }
      // The pattern's i flag reads a lower-case word too; a bare id is
      // Slack's own capitals only.
      return id !== undefined && id === id.toUpperCase() && outside([id], [])
        ? ""
        : whole;
    },
  );
  return { text: kept, dropped };
}

/**
 * What a row's text may say: no group mention, and, past a person's own words
 * (an instruction or its mirror), no Slack reference outside the row's
 * conversation. Each removal can join the text around it into a new one, so
 * both run again until nothing changes; each pass only shortens the text.
 * `dropped` gathers the ids taken out, over every text the guard is given.
 */
export function slackOutboxGuard(
  claim: Pick<SurfaceOutboxClaim, "kind" | "channelId" | "conversationScope">,
): { guard: SlackTextGuard; dropped: Set<string> } {
  const own = claim.kind === "instruction" || claim.kind === "input_mirror";
  const scope = slackOutboxScope(claim);
  const dropped = new Set<string>();
  const guard = (value: string) => {
    let text = value;
    for (;;) {
      let next = stripSlackGroupMentions(text);
      if (!own) {
        const scoped = dropOutOfScopeSlackRefs(next, scope);
        for (const id of scoped.dropped) dropped.add(id);
        next = scoped.text;
      }
      if (next === text) return text;
      text = next;
    }
  };
  return { guard, dropped };
}

/**
 * The body with its Markdown guarded. A card's blocks and text are its own,
 * escaped already; its model text is left to the card's own renderer.
 */
export function guardSlackOutboxBody(
  claim: Pick<
    SurfaceOutboxClaim,
    "kind" | "body" | "channelId" | "conversationScope"
  >,
): { body: SurfaceOutboxEntry["body"]; dropped: string[] } {
  const { body } = claim;
  if (body.blocks !== undefined) return { body, dropped: [] };
  const { guard, dropped } = slackOutboxGuard(claim);
  return { body: { ...body, text: guard(body.text) }, dropped: [...dropped] };
}

export function slackInstructionFallbackText(
  body: SurfaceOutboxEntry["body"],
  text: string,
  username: string,
  guard?: SlackTextGuard,
): string {
  const named = `${username}\n`;
  return body.text.startsWith(named)
    ? text
    : slackOutboxText({ ...body, text: named + body.text }, guard);
}
