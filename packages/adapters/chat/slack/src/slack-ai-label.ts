import { DEFAULT_USER_LOCALE, type UserLocale } from "@werft-ai/contracts";

const WORDS: Readonly<
  Record<UserLocale, { agent: string; requested: (name: string) => string }>
> = {
  ko: { agent: "AI 에이전트 · Werft", requested: (name) => `${name} 님 요청` },
  ja: {
    agent: "AIエージェント · Werft",
    requested: (name) => `${name} さんの依頼`,
  },
  en: {
    agent: "AI agent · Werft",
    requested: (name) => `Requested by ${name}`,
  },
};

// A name past this is cut: the line stays one short line.
const NAME_MAX = 80;

/**
 * The line an agent's post ends with: written by AI, and for whom when a
 * person asked (terms 15). The one place it is worded.
 */
export function slackAiLabelText(
  locale: UserLocale | undefined,
  requestedBy?: string,
): string {
  const words = WORDS[locale ?? DEFAULT_USER_LOCALE];
  const name = [...(requestedBy?.replace(/\s+/g, " ").trim() ?? "")];
  if (name.length === 0) return words.agent;
  const shown =
    name.length <= NAME_MAX
      ? name.join("")
      : `${name.slice(0, NAME_MAX - 1).join("")}…`;
  return `${words.agent} · ${words.requested(shown)}`;
}

/** The line as a context block: plain text, so a name is never a link or mention. */
export function slackAiLabelBlock(
  locale: UserLocale | undefined,
  requestedBy?: string,
): unknown {
  return {
    type: "context",
    elements: [
      {
        type: "plain_text",
        text: slackAiLabelText(locale, requestedBy),
        emoji: false,
      },
    ],
  };
}

/**
 * The line as mrkdwn, for a post's text: every `&`, `<` and `>` escaped, so
 * no control in a name, a link included, is read as one.
 */
export function slackAiLabelMrkdwn(
  locale: UserLocale | undefined,
  requestedBy?: string,
): string {
  return slackAiLabelText(locale, requestedBy)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
