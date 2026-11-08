import type {
  TurnEventMessage,
  TurnEventPart,
  TurnEventPresentation,
} from "@werft-ai/contracts";

import { markdownPlainText } from "./markdown-text.ts";

/*
 * presentTurnEvent says what an event is as message keys; the screen owns the
 * wording, so every session pattern takes this function instead of copy.
 */
export type FormatTurnMessage = (message: TurnEventMessage) => string;

// How much of a reply a one-line spot shows.
const PREVIEW_MAX = 200;

/**
 * A presentation as the one line a spot that shows only a start of it
 * carries: a reply with its Markdown marks taken off, anything else as its
 * summary.
 */
export function turnPreviewText(
  presentation: TurnEventPresentation,
  formatMessage: FormatTurnMessage,
): string {
  return presentation.reply === undefined
    ? turnSummaryText(presentation.summary, formatMessage)
    : markdownPlainText(presentation.reply, PREVIEW_MAX);
}

/** A presentation's summary as the one line a reader sees. */
export function turnSummaryText(
  summary: readonly TurnEventPart[],
  formatMessage: FormatTurnMessage,
): string {
  return summary
    .map((part) => ("text" in part ? part.text : formatMessage(part)))
    .join(" · ");
}
