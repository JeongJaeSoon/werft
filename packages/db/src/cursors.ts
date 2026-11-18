// Every public page cursor is minted and checked here. Anything a decoder
// does not recognise is InvalidCursorError, which the routes answer with 400.
import {
  TEAM_NAME_MAX,
  userIdSchema,
  sessionIdSchema as uuidSchema,
} from "@werft-ai/contracts";
import { InvalidCursorError } from "@werft-ai/platform";
import { SEQUENCE_MAX } from "./control-shared.ts";

// The public SSE `id:` and the worker's append cursor are the same value: the
// events row id in base36 behind an `ev_` prefix. Opaque to clients, but
// stable across the worker protocol and the public stream so a client that
// saw the gateway's cursor can resume the stream from it.
const EVENT_CURSOR = /^ev_[0-9a-z]{1,11}$/;

export function encodeEventCursor(id: number): string {
  return `ev_${id.toString(36)}`;
}

// 0 means "from the beginning"; there is no row 0, so `> 0` reads everything.
export function decodeEventCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!EVENT_CURSOR.test(cursor)) throw new InvalidCursorError();
  const id = Number.parseInt(cursor.slice(3), 36);
  if (!Number.isSafeInteger(id) || id < 0) throw new InvalidCursorError();
  return id;
}

function encodeJsonCursor(cursor: object): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeJsonCursor<T>(
  value: string,
  accept: (parsed: Record<string, unknown>) => T | undefined,
): T {
  try {
    const cursor = accept(
      JSON.parse(Buffer.from(value, "base64url").toString()),
    );
    if (cursor !== undefined) return cursor;
  } catch {}
  throw new InvalidCursorError();
}

// Sessions, agents and API keys page on (created_at, id). created_at is the database's
// own text rendering so microsecond precision survives the round trip (JS Date
// would truncate to milliseconds).
export type CreatedAtCursor = { created_at: string; id: string };
// Only the exact shape PostgreSQL renders; JS Date.parse is far more lenient
// than the timestamptz cast and a forged cursor must not reach the query.
const PG_TIMESTAMPTZ_TEXT =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export function encodeCreatedAtCursor(cursor: CreatedAtCursor): string {
  return encodeJsonCursor(cursor);
}

export function decodeCreatedAtCursor(value: string): CreatedAtCursor {
  return decodeJsonCursor(value, (parsed) =>
    typeof parsed.created_at === "string" &&
    PG_TIMESTAMPTZ_TEXT.test(parsed.created_at) &&
    uuidSchema.safeParse(parsed.id).success
      ? (parsed as CreatedAtCursor)
      : undefined,
  );
}

// A well-formed but out-of-range timestamp (month 13) only fails at the
// cast: SQLSTATE 22007/22008 mean the cursor, not the DB.
export function rethrowCursorCastError(error: unknown): never {
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  if (code === "22007" || code === "22008") throw new InvalidCursorError();
  throw error;
}

// Turns page in FIFO order; the cursor is the last sequence on the page.
export type TurnCursor = { sequence: number };

export function encodeTurnCursor(cursor: TurnCursor): string {
  return encodeJsonCursor(cursor);
}

export function decodeTurnCursor(value: string): TurnCursor {
  return decodeJsonCursor(value, (parsed) =>
    typeof parsed.sequence === "number" &&
    Number.isInteger(parsed.sequence) &&
    parsed.sequence >= 1 &&
    parsed.sequence <= SEQUENCE_MAX
      ? { sequence: parsed.sequence }
      : undefined,
  );
}

// A tool's calls page newest or slowest first, ties on (use_event_id, ord).
// `at` is text for the same reason; `ms` is null past the timed calls.
export type ToolCallCursor =
  | { sort: "recent"; at: string; id: number; ord: number }
  | { sort: "slowest"; ms: number | null; id: number; ord: number };

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
// tool_calls.ord is a Postgres integer; a larger one fails the cast as 500.
const ordinal = (value: unknown): value is number =>
  positive(value) && value <= 2_147_483_647;

export function encodeToolCallCursor(cursor: ToolCallCursor): string {
  return encodeJsonCursor(cursor);
}

/** A cursor minted for the other sort is no cursor for this one. */
export function decodeToolCallCursor(
  value: string,
  sort: ToolCallCursor["sort"],
): ToolCallCursor {
  return decodeJsonCursor(value, (parsed): ToolCallCursor | undefined => {
    if (parsed.sort !== sort || !positive(parsed.id) || !ordinal(parsed.ord)) {
      return undefined;
    }
    if (
      sort === "recent" &&
      typeof parsed.at === "string" &&
      PG_TIMESTAMPTZ_TEXT.test(parsed.at)
    ) {
      return { sort, at: parsed.at, id: parsed.id, ord: parsed.ord };
    }
    if (
      sort === "slowest" &&
      (parsed.ms === null ||
        (typeof parsed.ms === "number" &&
          Number.isSafeInteger(parsed.ms) &&
          parsed.ms >= 0))
    ) {
      return { sort, ms: parsed.ms, id: parsed.id, ord: parsed.ord };
    }
    return undefined;
  });
}

// Members page oldest membership first; created_at is text for the same reason.
export type MemberCursor = { created_at: string; user_id: string };

export function encodeMemberCursor(cursor: MemberCursor): string {
  return encodeJsonCursor(cursor);
}

export function decodeMemberCursor(value: string): MemberCursor {
  return decodeJsonCursor(value, (parsed) =>
    typeof parsed.created_at === "string" &&
    PG_TIMESTAMPTZ_TEXT.test(parsed.created_at) &&
    userIdSchema.safeParse(parsed.user_id).success
      ? { created_at: parsed.created_at, user_id: parsed.user_id as string }
      : undefined,
  );
}

// Teams page by name, then id. A NUL never reaches the query: PostgreSQL text
// cannot hold one and would answer 500 instead of 400.
export type TeamCursor = { name: string; id: string };

export function encodeTeamCursor(cursor: TeamCursor): string {
  return encodeJsonCursor({ name: cursor.name, id: cursor.id });
}

export function decodeTeamCursor(value: string): TeamCursor {
  return decodeJsonCursor(value, (parsed) =>
    typeof parsed.name === "string" &&
    parsed.name.length >= 1 &&
    parsed.name.length <= TEAM_NAME_MAX &&
    !parsed.name.includes("\0") &&
    uuidSchema.safeParse(parsed.id).success
      ? { name: parsed.name, id: parsed.id as string }
      : undefined,
  );
}
