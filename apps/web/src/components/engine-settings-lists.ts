/**
 * The rule lists as the API reads and writes them. Spelled out rather than
 * taken from the contracts' schema type, which allows `undefined` in a list
 * the generated request type does not.
 */
export interface EngineRules {
  readonly permissions: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
  };
  readonly auto_mode: {
    allow?: string[];
    soft_deny?: string[];
    hard_deny?: string[];
    environment?: string[];
  };
}

/**
 * The six rule lists an engine settings save replaces: three permission
 * lists and four auto mode lists, keyed the way the API stores them.
 */
export const ENGINE_LISTS = [
  { group: "permissions", key: "allow" },
  { group: "permissions", key: "ask" },
  { group: "permissions", key: "deny" },
  { group: "auto_mode", key: "allow" },
  { group: "auto_mode", key: "soft_deny" },
  { group: "auto_mode", key: "hard_deny" },
  { group: "auto_mode", key: "environment" },
] as const;
export type EngineList = (typeof ENGINE_LISTS)[number];

/** `permissions.allow`, `auto_mode.soft_deny`, ... : one id per list. */
export const listId = (list: EngineList) => `${list.group}.${list.key}`;

/**
 * Lists a line-per-rule box cannot hold without changing them: the server
 * accepts a sentence with a line break inside, which the box would read back
 * as two. Such a list is shown but never edited here, and a save sends it as
 * it was read.
 */
export function lockedIds(saved: EngineRules): ReadonlySet<string> {
  return new Set(
    ENGINE_LISTS.filter((list) =>
      rulesOf(saved, list).some((rule) => /[\r\n]/.test(rule)),
    ).map(listId),
  );
}

/** What each textarea holds, by `listId`: one rule per line. */
export type EngineDraft = Readonly<Record<string, string>>;

type Group = Readonly<Record<string, readonly string[] | undefined>>;

const rulesOf = (settings: EngineRules, list: EngineList) =>
  (settings[list.group] as Group)[list.key] ?? [];

export function draftOf(settings: EngineRules): EngineDraft {
  return Object.fromEntries(
    ENGINE_LISTS.map((list) => [
      listId(list),
      rulesOf(settings, list).join("\n"),
    ]),
  );
}

/** Blank lines are not rules, and a rule keeps no padding. Order is kept. */
export function rulesOfText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The settings a draft stands for. A list with no rules is left out, which is
 * how the API stores an empty one, so a draft that matches what was read
 * produces the same document and no save is offered for it.
 */
export function settingsOf(
  draft: EngineDraft,
  saved: EngineRules,
): EngineRules {
  const permissions: Record<string, string[]> = {};
  const autoMode: Record<string, string[]> = {};
  const locked = lockedIds(saved);
  for (const list of ENGINE_LISTS) {
    const rules = locked.has(listId(list))
      ? [...rulesOf(saved, list)]
      : rulesOfText(draft[listId(list)] ?? "");
    if (rules.length === 0) continue;
    (list.group === "permissions" ? permissions : autoMode)[list.key] = rules;
  }
  return { permissions, auto_mode: autoMode };
}

/** Whether saving the draft would change what the server holds. */
export function isDirty(draft: EngineDraft, saved: EngineRules): boolean {
  const locked = lockedIds(saved);
  return ENGINE_LISTS.some((list) => {
    if (locked.has(listId(list))) return false;
    const now = rulesOfText(draft[listId(list)] ?? "");
    const before = rulesOf(saved, list);
    return now.length !== before.length || now.some((r, i) => r !== before[i]);
  });
}

/**
 * The rules a list holds now, for the count shown beside its limit. A locked
 * list counts what a save sends, not the lines its box shows.
 */
export const countOf = (
  draft: EngineDraft,
  list: EngineList,
  saved: EngineRules,
) =>
  lockedIds(saved).has(listId(list))
    ? rulesOf(saved, list).length
    : rulesOfText(draft[listId(list)] ?? "").length;
