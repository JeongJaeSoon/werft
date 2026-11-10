import {
  engineSettingsStartSchema,
  STORED_AUTO_MODE_KEYS,
  STORED_PERMISSION_KEYS,
  type StoredEngineSettings,
} from "@werft-ai/contracts";

/** The agent's saved engine settings, as the readers need them. */
export type AgentEngineSettingsView = StoredEngineSettings & {
  /** `agent_engine_settings.revision`; a row is never deleted, so it never repeats. */
  revision: number;
};

type Lists<Key extends string> = Record<Key, string[]>;
export type EffectivePermissions = Lists<
  (typeof STORED_PERMISSION_KEYS)[number]
>;
export type EffectiveAutoMode = Lists<(typeof STORED_AUTO_MODE_KEYS)[number]>;

/**
 * What the agent's own settings contribute to one session now.
 *
 * `rules` with every list empty is neutral: the agent adds nothing. `closed`
 * is not neutral. It says the agent's settings cannot be trusted for this
 * session (the snapshot does not parse, or the row it came from is gone or
 * older than the snapshot), and whoever sends the settings to the engine must
 * refuse or fall back to the most restrictive choice, never to no rules.
 */
export type EffectiveEngineSettings =
  | {
      kind: "rules";
      permissions: EffectivePermissions;
      autoMode: EffectiveAutoMode;
    }
  | {
      kind: "closed";
      reason: "invalid_start" | "row_missing" | "revision_regressed";
    };

type Rules = Partial<Record<string, readonly string[]>>;

const union = (a: readonly string[] = [], b: readonly string[] = []) =>
  [...new Set([...a, ...b])].sort();
const intersection = (a: readonly string[] = [], b: readonly string[] = []) => {
  const inB = new Set(b);
  return [...new Set(a)].filter((rule) => inB.has(rule)).sort();
};

/**
 * A rule list narrows a session when it adds a deny, an ask or a stricter
 * classifier sentence; it widens one when it adds an allow or a sentence that
 * relaxes the classifier. These are the lists that restrict.
 */
const RESTRICTING = new Set(["ask", "deny", "soft_deny", "hard_deny"]);

function combine<Key extends string>(
  keys: readonly Key[],
  start: Rules | null,
  now: Rules,
): Lists<Key> {
  const out = {} as Lists<Key>;
  for (const key of keys) {
    out[key] = RESTRICTING.has(key)
      ? // Restriction takes effect at once and is never given back.
        union(start?.[key], now[key])
      : // A grant is what the session started with and the agent still has:
        // a widening reaches the next session, a narrowing this one. A session
        // with no snapshot started with no grants.
        start === null
        ? []
        : intersection(start[key], now[key]);
  }
  return out;
}

/**
 * The agent's rules one session follows now: what it started with
 * (`start`, the snapshot taken when it was created, or null for a session
 * that has none) and the agent's saved row. Restrictions in either apply; a
 * grant needs both, so a change narrows a running session at once and widens
 * only the next one. A session with no snapshot started with no agent rules,
 * so a row saved afterwards can restrict it and never grant it anything.
 *
 * Pure and not called by any claim path yet: it is the meaning the merge that
 * sends settings to the engine will use.
 *
 * Auto mode sentences are classifier prose. Combining them this way keeps the
 * agent from relaxing the workspace's sentences, but it is not a guarantee a
 * deny rule gives.
 */
export function effectiveEngineSettings(input: {
  start: unknown;
  row: AgentEngineSettingsView | null;
}): EffectiveEngineSettings {
  let start: StoredEngineSettings | null = null;
  if (input.start !== null && input.start !== undefined) {
    const parsed = engineSettingsStartSchema.safeParse(input.start);
    if (!parsed.success) return { kind: "closed", reason: "invalid_start" };
    if (input.row === null) return { kind: "closed", reason: "row_missing" };
    if (input.row.revision < parsed.data.revision) {
      return { kind: "closed", reason: "revision_regressed" };
    }
    start = parsed.data;
  }
  return {
    kind: "rules",
    permissions: combine(
      STORED_PERMISSION_KEYS,
      start?.permissions ?? null,
      input.row?.permissions ?? {},
    ),
    autoMode: combine(
      STORED_AUTO_MODE_KEYS,
      start?.auto_mode ?? null,
      input.row?.auto_mode ?? {},
    ),
  };
}
