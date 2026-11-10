// The rewrite every accepted span goes through. What a worker says about
// tenant, session or backend is never trusted: those keys are removed at
// every level (resource, span, event, link) and then stamped from the
// credential's own row.

import {
  type ContentMode,
  type IngestAttributes,
  type IngestSpan,
  isContentAttribute,
} from "@werft-ai/observability";
import type { IngestAttempt, ValueMasker } from "./ports.ts";

const OWNED_KEYS: ReadonlySet<string> = new Set([
  "werft.workspace_id",
  "werft.session_id",
  "werft.attempt_id",
  "werft.execution_id",
  "werft.execution_generation",
  "werft.fenced",
  "werft.content_dropped",
  "session.id",
  "gen_ai.conversation.id",
]);

// Collector-specific keys; the listener never adds them, and a worker's are removed.
const FOREIGN_PREFIXES = ["langfuse."] as const;

function owned(key: string): boolean {
  return OWNED_KEYS.has(key) || FOREIGN_PREFIXES.some((p) => key.startsWith(p));
}

export interface SanitizeContext {
  readonly attempt: IngestAttempt;
  readonly contentMode: ContentMode;
  /** The trace is over its byte budget: the rest of it carries no content. */
  readonly contentDropped: boolean;
  readonly fenced: boolean;
  readonly masker: ValueMasker;
}

function clean(
  attributes: IngestAttributes,
  keepContent: boolean,
  masker: ValueMasker,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (owned(key)) continue;
    if (isContentAttribute(key)) {
      if (!keepContent) continue;
      out[key] = typeof value === "string" ? masker.mask(value) : value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function identity(attempt: IngestAttempt): Record<string, string | number> {
  return {
    "werft.session_id": attempt.sessionId,
    "session.id": attempt.sessionId,
    "gen_ai.conversation.id": attempt.sessionId,
    "werft.attempt_id": attempt.attemptId,
    ...(attempt.workspaceId === undefined
      ? {}
      : { "werft.workspace_id": attempt.workspaceId }),
  };
}

export function sanitizeSpan(
  span: IngestSpan,
  ctx: SanitizeContext,
): IngestSpan {
  const keepContent = ctx.contentMode === "full" && !ctx.contentDropped;
  const { attempt } = ctx;
  return {
    ...span,
    // Always the credential's session: a worker cannot place a span elsewhere.
    attributes: {
      ...clean(span.attributes, keepContent, ctx.masker),
      ...identity(attempt),
      ...(ctx.fenced ? { "werft.fenced": true } : {}),
      ...(ctx.contentDropped ? { "werft.content_dropped": true } : {}),
    },
    events: span.events.map((event) => ({
      ...event,
      attributes: clean(event.attributes, keepContent, ctx.masker),
    })),
    links: span.links.map((link) => ({
      ...link,
      attributes: clean(link.attributes, keepContent, ctx.masker),
    })),
    status:
      span.status.message === undefined
        ? span.status
        : { ...span.status, message: ctx.masker.mask(span.status.message) },
    resource: {
      ...clean(span.resource, false, ctx.masker),
      ...identity(attempt),
      "werft.execution_id": attempt.executionId,
      "werft.execution_generation": attempt.executionGeneration,
    },
  };
}
