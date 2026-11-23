import {
  type ConversationInputId,
  conversationInputIdSchema,
  slackScopeSegmentSchema,
  slackTsSchema,
} from "@werft-ai/contracts";
import { z } from "zod";

/**
 * Most keys one source set lists. Past it the set keeps its first keys and
 * says `overflow`; every key a turn inherits is a direct key of an earlier
 * turn of its session, so a reader of an overflowed set judges by those.
 */
export const SOURCE_SET_LIMIT = 256;

/** Where a Slack message is: what a delete mark names. */
export type SourcePlace = { teamId: string; channelId: string; ts: string };

/**
 * One input something came from: its Slack place, which the delete and edit
 * marks match, and its input row once that is known. Never its text.
 */
export type SourceKey = {
  inputId: ConversationInputId | null;
  slack: SourcePlace | null;
};

/**
 * What a turn or an outbox row came from. `direct`: the turn's own input
 * (and, later, what its tools read); `inherited`: everything earlier turns
 * of its session came from, which the engine's context still holds.
 */
export type SourceSet = {
  direct: SourceKey[];
  inherited: SourceKey[];
  overflow: boolean;
};

export const EMPTY_SOURCE_SET: SourceSet = {
  direct: [],
  inherited: [],
  overflow: false,
};

const storedKeySchema = z
  .object({
    input_id: conversationInputIdSchema.optional(),
    team_id: slackScopeSegmentSchema.optional(),
    channel_id: slackScopeSegmentSchema.optional(),
    ts: slackTsSchema.optional(),
  })
  .strict()
  .refine(
    (key) =>
      (key.team_id === undefined) === (key.channel_id === undefined) &&
      (key.team_id === undefined) === (key.ts === undefined) &&
      (key.input_id !== undefined || key.ts !== undefined),
  );

const storedSetSchema = z
  .object({
    direct: z.array(storedKeySchema),
    inherited: z.array(storedKeySchema),
    overflow: z.literal(true).optional(),
  })
  .strict();

/** The stored shape: a jsonb `sources` column, snake_case like slack_message. */
export type StoredSourceSet = z.infer<typeof storedSetSchema>;

function storedKey(key: SourceKey): StoredSourceSet["direct"][number] {
  return {
    ...(key.inputId === null ? {} : { input_id: key.inputId }),
    ...(key.slack === null
      ? {}
      : {
          team_id: key.slack.teamId,
          channel_id: key.slack.channelId,
          ts: key.slack.ts,
        }),
  };
}

/** Null for a set with nothing in it: the column holds no empty sets. */
export function storedSourceSet(set: SourceSet): StoredSourceSet | null {
  if (set.direct.length === 0 && set.inherited.length === 0) return null;
  return {
    direct: set.direct.map(storedKey),
    inherited: set.inherited.map(storedKey),
    ...(set.overflow ? { overflow: true as const } : {}),
  };
}

/**
 * Reads a stored column back. Null, and a value of no shape this reads, is
 * the empty set: a row from before 0322, or from a turn with no source.
 */
export function sourceSetOf(stored: unknown): SourceSet {
  const parsed = storedSetSchema.safeParse(stored);
  if (!parsed.success) return EMPTY_SOURCE_SET;
  const keyOf = (key: StoredSourceSet["direct"][number]): SourceKey => ({
    inputId: key.input_id ?? null,
    slack:
      key.ts === undefined
        ? null
        : {
            teamId: key.team_id as string,
            channelId: key.channel_id as string,
            ts: key.ts,
          },
  });
  return {
    direct: parsed.data.direct.map(keyOf),
    inherited: parsed.data.inherited.map(keyOf),
    overflow: parsed.data.overflow === true,
  };
}

function samePlace(a: SourcePlace | null, b: SourcePlace | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.teamId === b.teamId &&
    a.channelId === b.channelId &&
    a.ts === b.ts
  );
}

/** One input: the same input row, or the same Slack place. */
export function sameSource(a: SourceKey, b: SourceKey): boolean {
  return (
    (a.inputId !== null && a.inputId === b.inputId) ||
    samePlace(a.slack, b.slack)
  );
}

/**
 * The union of what read pieces came from, each input once, in the order it
 * first appears; a key one list knows the input row or place of fills the
 * other's gap. Past `limit` it keeps the first keys and says `overflow`.
 */
export function mergeSources(
  lists: readonly (readonly SourceKey[])[],
  limit: number = SOURCE_SET_LIMIT,
): { keys: SourceKey[]; overflow: boolean } {
  const keys: SourceKey[] = [];
  let overflow = false;
  for (const list of lists) {
    for (const key of list) {
      const matches = keys.flatMap((kept, i) =>
        sameSource(kept, key) ? [i] : [],
      );
      if (matches.length > 0) {
        // A key with both parts can join one kept by row and one by place.
        const [first, ...rest] = matches as [number, ...number[]];
        let joined = key;
        for (const i of matches) {
          const kept = keys[i] as SourceKey;
          joined = {
            inputId: kept.inputId ?? joined.inputId,
            slack: kept.slack ?? joined.slack,
          };
        }
        keys[first] = joined;
        for (const i of rest.reverse()) keys.splice(i, 1);
      } else if (keys.length < limit) {
        keys.push(key);
      } else {
        overflow = true;
      }
    }
  }
  return { keys, overflow };
}

/**
 * A new turn's sources: its own input, and everything its session's earlier
 * turns came from. A key in `direct` is not inherited again.
 */
export function turnSources(input: {
  direct: readonly SourceKey[];
  earlier: readonly SourceSet[];
  limit?: number;
}): SourceSet {
  const limit = input.limit ?? SOURCE_SET_LIMIT;
  const direct = mergeSources([input.direct], limit);
  const inherited = mergeSources(
    // Inherited keys came before a set's direct ones.
    input.earlier.flatMap((set) => [set.inherited, set.direct]),
    limit,
  );
  const kept = inherited.keys.filter(
    (key) => !direct.keys.some((own) => sameSource(own, key)),
  );
  const room = Math.max(0, limit - direct.keys.length);
  return {
    direct: direct.keys,
    inherited: kept.slice(0, room),
    overflow:
      direct.overflow ||
      inherited.overflow ||
      kept.length > room ||
      input.earlier.some((set) => set.overflow),
  };
}

/** A Slack message's key before its input row is known. */
export function placeSource(place: SourcePlace): SourceKey {
  return { inputId: null, slack: place };
}
