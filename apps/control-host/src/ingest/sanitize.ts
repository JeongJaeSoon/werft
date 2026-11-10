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

// Without content, only keys known to describe the work (not its payload)
// pass: a list of what to remove can never be complete, since a worker may
// name its content anything (`output.value`). Values are short for the same
// reason. This narrows the channel; it cannot close it for a worker that
// hides text in a `werft.*` value, which the same-session limit in the design
// (2.2) already accepts.
const METADATA_PREFIXES = [
  "werft.",
  "gen_ai.",
  "service.",
  "telemetry.",
  "error.",
  "http.",
] as const;
const METADATA_VALUE_CHARS = 256;

function metadataValue(value: string | number | boolean) {
  return typeof value === "string" && value.length > METADATA_VALUE_CHARS
    ? value.slice(0, METADATA_VALUE_CHARS)
    : value;
}

function clean(
  attributes: IngestAttributes,
  keepContent: boolean,
  masker: ValueMasker,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (owned(key)) continue;
    if (!keepContent) {
      if (
        !isContentAttribute(key) &&
        METADATA_PREFIXES.some((prefix) => key.startsWith(prefix))
      ) {
        out[key] = metadataValue(value);
      }
      continue;
    }
    out[key] =
      isContentAttribute(key) && typeof value === "string"
        ? masker.mask(value)
        : value;
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
    name: keepContent ? span.name : span.name.slice(0, METADATA_VALUE_CHARS),
    // Always the credential's session: a worker cannot place a span elsewhere.
    attributes: {
      ...clean(span.attributes, keepContent, ctx.masker),
      ...identity(attempt),
      ...(ctx.fenced ? { "werft.fenced": true } : {}),
      ...(ctx.contentDropped ? { "werft.content_dropped": true } : {}),
    },
    events: span.events.map((event) => ({
      ...event,
      name: keepContent
        ? event.name
        : event.name.slice(0, METADATA_VALUE_CHARS),
      attributes: clean(event.attributes, keepContent, ctx.masker),
    })),
    links: span.links.map((link) => ({
      ...link,
      attributes: clean(link.attributes, keepContent, ctx.masker),
    })),
    // A failure message is free text: it stays only where content does.
    status:
      span.status.message === undefined || !keepContent
        ? { code: span.status.code }
        : { ...span.status, message: ctx.masker.mask(span.status.message) },
    resource: {
      ...clean(span.resource, false, ctx.masker),
      ...identity(attempt),
      "werft.execution_id": attempt.executionId,
      "werft.execution_generation": attempt.executionGeneration,
    },
  };
}
