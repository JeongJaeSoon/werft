import type {
  SessionEventName,
  SessionEventPayload,
} from "@werft-ai/contracts";
import type { ContractIssue } from "./contract.ts";

/** One `text/event-stream` frame as it came off the wire. */
export interface RawFrame {
  readonly id: string | undefined;
  readonly event: string;
  readonly data: string;
}

/**
 * Turns decoded text, split anywhere, into frames: the subset of the
 * WHATWG event-stream format the server writes (id, event, data, comments).
 */
export function createFrameParser(): { push(text: string): RawFrame[] } {
  let buffer = "";
  let id: string | undefined;
  let event = "";
  let data: string[] = [];
  return {
    push(text) {
      buffer += text;
      const frames: RawFrame[] = [];
      for (;;) {
        const end = buffer.search(/\r\n|\r|\n/);
        // A lone CR at the end may be the first half of a CRLF.
        if (end < 0 || (end === buffer.length - 1 && buffer[end] === "\r"))
          break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));
        if (line === "") {
          if (data.length > 0)
            frames.push({
              id,
              event: event || "message",
              data: data.join("\n"),
            });
          id = undefined;
          event = "";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "id" && !value.includes("\0")) id = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      return frames;
    },
  };
}

// A record, so a kind added to the contract fails the typecheck until it is
// known here (the client imports contracts as types only).
const EVENT_NAMES: Readonly<Record<string, true>> = {
  system: true,
  assistant: true,
  tool_use: true,
  tool_result: true,
  question: true,
  result: true,
  status: true,
  error: true,
} satisfies Record<SessionEventName, true>;
export const SESSION_EVENT_NAMES = Object.keys(EVENT_NAMES);
export const SSE_SCHEMA_VERSION = 1;

/** One event, its envelope unpacked next to the kind's payload. */
export interface SessionEventFrame {
  /** The replay cursor: pass it back as `lastEventId` to resume after it. */
  readonly id: string;
  readonly occurredAt: string;
  readonly turnId: string | null;
  readonly attemptId: string | null;
  readonly payload: SessionEventPayload;
}

type FrameReading =
  | {
      readonly kind: "event";
      readonly frame: SessionEventFrame;
      /** The frame as the contract names it, for a full validator. */
      readonly wire: { id: string; event: string; data: unknown };
    }
  /**
   * A kind newer than this client. Expected while a server rolls ahead of
   * its readers, so only a strict client calls it a mismatch.
   */
  | { readonly kind: "unknown"; readonly issues: readonly ContractIssue[] }
  | { readonly kind: "mismatch"; readonly issues: readonly ContractIssue[] };

/**
 * The envelope check every frame gets, in every mode and without a schema
 * library: what a frame must hold to be shown at all.
 */
export function readFrame(raw: RawFrame, sessionId: string): FrameReading {
  const issue = (path: string, message: string): FrameReading => ({
    kind: "mismatch",
    issues: [{ path, message }],
  });
  if (!raw.id) return issue("id", "missing");
  if (!Object.hasOwn(EVENT_NAMES, raw.event))
    return {
      kind: "unknown",
      issues: [{ path: "event", message: "unknown kind" }],
    };
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw.data);
  } catch {
    return issue("data", "not JSON");
  }
  if (typeof envelope !== "object" || envelope === null)
    return issue("data", "not an object");
  const fields = envelope as Record<string, unknown>;
  // Unlike a new kind, a new envelope version changes every frame: left
  // silent, the stream would stay open and show nothing.
  if (fields.schema_version !== SSE_SCHEMA_VERSION)
    return issue("data.schema_version", `not ${SSE_SCHEMA_VERSION}`);
  if (
    typeof fields.session_id !== "string" ||
    fields.session_id.toLowerCase() !== sessionId.toLowerCase()
  )
    return issue("data.session_id", "not the subscribed session");
  if (typeof fields.occurred_at !== "string")
    return issue("data.occurred_at", "not a string");
  for (const key of ["turn_id", "attempt_id"] as const) {
    const value = fields[key];
    if (value !== null && typeof value !== "string")
      return issue(`data.${key}`, "not a string or null");
  }
  if (!("data" in fields)) return issue("data.data", "missing");
  return {
    kind: "event",
    frame: {
      id: raw.id,
      occurredAt: fields.occurred_at,
      turnId: fields.turn_id as string | null,
      attemptId: fields.attempt_id as string | null,
      payload: { event: raw.event, data: fields.data } as SessionEventPayload,
    },
    wire: { id: raw.id, event: raw.event, data: envelope },
  };
}
