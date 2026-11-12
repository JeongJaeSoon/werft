import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runsOutsideTransaction } from "./migrate.ts";
import { readJournal } from "./migration-journal.ts";

// Tables that grow with use. DDL that rewrites one, or scans it under a lock
// that blocks writes, stalls the API for as long as the table is large; a
// backfill of one inside the migration transaction holds its row locks to
// the end. A new table of that kind goes on this list.
export const GROWING_TABLES: readonly string[] = [
  "achievement_judgment_usage",
  "achievement_judgments",
  "agent_activation_events",
  "approval_checkpoints",
  "attempts",
  "authz_decisions",
  "checkpoint_output_objects",
  "checkpoint_outputs",
  "checkpoints",
  "control_intents",
  "events",
  "executions",
  "github_workflow_dispatches",
  "idempotency_keys",
  "pending_requests",
  "provider_usage",
  "pull_requests",
  "push_continuations",
  "push_requests",
  "receipts",
  "session_achievements",
  "session_event_archives",
  "session_links",
  "session_model_usage",
  "session_outcomes",
  "session_title_requests",
  "sessions",
  "slack_inbound_events",
  "slack_outbox",
  "tool_call_days",
  "tool_calls",
  "turn_continuations",
  "turns",
  "web_sessions",
  "worker_launches",
];

// Migrations up to this one were reviewed when the rules were written
// and have run on every installation; only later ones are checked.
const SAFETY_CHECKED_AFTER_IDX = 200;

const VOLATILE_DEFAULT =
  /\bDEFAULT\s+[^,;]*\b(gen_random_uuid|uuid_generate_v\d\w*|random|clock_timestamp|timeofday|nextval)\s*\(/i;
const ADDS_COLUMN =
  /\bADD (?:COLUMN )?(?:IF NOT EXISTS )?(?!(?:CONSTRAINT|FOREIGN|UNIQUE|PRIMARY|CHECK|EXCLUDE)\b)"?\w/i;
const FILLED_COLUMN = /\b(?:small|big)?serial\b|\bGENERATED\b/i;
const INLINE_INDEX_OR_KEY = /\b(?:UNIQUE|PRIMARY KEY|REFERENCES)\b/i;

function statementsOf(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .map((line) => line.replace(/\s+--[^'"]*$/, ""))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

const name = `"?([a-z_0-9]+)"?`;
const qualified = String.raw`(?:"?public"?\.)?${name}`;

/** Every rule a migration after the baseline breaks; empty when all hold. */
export function migrationSafetyProblems(
  folder: string,
  checkedAfterIdx = SAFETY_CHECKED_AFTER_IDX,
): string[] {
  const growing = new Set(GROWING_TABLES);
  const problems: string[] = [];
  for (const entry of readJournal(folder)) {
    if (entry.idx <= checkedAfterIdx) {
      continue;
    }
    const file = `${entry.tag}.sql`;
    const raw = readFileSync(join(folder, file), "utf8");
    const outside = runsOutsideTransaction(
      raw.split("--> statement-breakpoint"),
    );
    const created = new Set<string>();
    const dropped = new Set<string>();
    const addedNotValid = new Set<string>();
    const existingGrowing = (table: string) =>
      growing.has(table) && !created.has(table);
    for (const statement of statementsOf(raw)) {
      // Every check reads one statement from its start, and a no-transaction
      // migration sent as one query string runs in an implicit transaction.
      const bare = statement.replace(/'(?:[^']|'')*'/g, "''");
      if (!/\$\w*\$/.test(bare) && /;\s*\S/.test(bare)) {
        problems.push(
          `${file}: more than one statement between breakpoints; put "--> statement-breakpoint" after each`,
        );
      }
      const createTable = statement.match(
        new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${qualified}`, "i"),
      );
      if (createTable?.[1]) {
        created.add(createTable[1]);
        continue;
      }
      if (/\bCONCURRENTLY\b/i.test(statement) && !outside) {
        problems.push(
          `${file}: CONCURRENTLY needs the migration's first line to be "-- migrate:no-transaction"`,
        );
      }
      const dropIndex = statement.match(
        new RegExp(`^DROP INDEX CONCURRENTLY IF EXISTS ${qualified}`, "i"),
      );
      if (dropIndex?.[1]) {
        dropped.add(dropIndex[1]);
      }
      const index = statement.match(
        new RegExp(
          `^CREATE (?:UNIQUE )?INDEX (CONCURRENTLY )?(?:IF NOT EXISTS )?(?:${name} )?ON (?:ONLY )?${qualified}`,
          "i",
        ),
      );
      if (index?.[3]) {
        const [, concurrently, indexName, table] = index;
        if (existingGrowing(table) && !concurrently) {
          problems.push(
            `${file}: index ${indexName ?? "(unnamed)"} on ${table} must be built CONCURRENTLY in a no-transaction migration`,
          );
        }
        if (concurrently && !indexName) {
          problems.push(
            `${file}: CREATE INDEX CONCURRENTLY on ${table} needs a name, so a failed build can be dropped before the next try`,
          );
        } else if (concurrently && indexName && !dropped.has(indexName)) {
          // A failed concurrent build leaves an INVALID index that IF NOT
          // EXISTS would then keep for good.
          problems.push(
            `${file}: CREATE INDEX CONCURRENTLY ${indexName} needs DROP INDEX CONCURRENTLY IF EXISTS ${indexName} before it`,
          );
        }
      }
      const alter = statement.match(
        new RegExp(
          `^ALTER TABLE (?:ONLY )?(?:IF EXISTS )?${qualified} (.*)$`,
          "i",
        ),
      );
      if (alter?.[1] && alter[2] !== undefined && existingGrowing(alter[1])) {
        const [, table, action] = alter;
        const addsColumn = ADDS_COLUMN.test(action);
        // A quoted column may be named "generated" or "references".
        const unquoted = action.replace(/"[^"]*"/g, '""');
        if (addsColumn && VOLATILE_DEFAULT.test(action)) {
          problems.push(
            `${file}: a volatile DEFAULT on a new column rewrites ${table}; add the column without it and backfill in batches`,
          );
        }
        if (addsColumn && FILLED_COLUMN.test(unquoted)) {
          problems.push(
            `${file}: a serial, identity or generated column rewrites ${table}; add a plain column and fill it in batches`,
          );
        } else if (
          addsColumn &&
          /\bNOT NULL\b/i.test(action) &&
          !/\bDEFAULT\b/i.test(action)
        ) {
          problems.push(
            `${file}: a NOT NULL column without a DEFAULT fails on a non-empty ${table}`,
          );
        }
        if (addsColumn && INLINE_INDEX_OR_KEY.test(unquoted)) {
          problems.push(
            `${file}: a UNIQUE, PRIMARY KEY or REFERENCES clause on a new column locks ${table} while it builds or checks; add the column, then the index or constraint the safe way`,
          );
        }
        if (/\bALTER COLUMN \S+ (SET DATA )?TYPE\b/i.test(action)) {
          problems.push(
            `${file}: changing a column type rewrites ${table} under an exclusive lock`,
          );
        }
        if (/\bSET NOT NULL\b/i.test(action)) {
          problems.push(
            `${file}: SET NOT NULL scans ${table} under an exclusive lock; VALIDATE a CHECK (... IS NOT NULL) NOT VALID in an earlier migration first`,
          );
        }
        const notValid = action.match(
          new RegExp(`\\bADD CONSTRAINT ${name} .*\\bNOT VALID\\b`, "i"),
        );
        if (notValid?.[1]) {
          addedNotValid.add(notValid[1]);
        }
        const validate = action.match(
          new RegExp(`\\bVALIDATE CONSTRAINT ${name}`, "i"),
        );
        if (!outside && validate?.[1] && addedNotValid.has(validate[1])) {
          problems.push(
            `${file}: VALIDATE CONSTRAINT ${validate[1]} runs under the lock its ADD took; validate it in a later migration`,
          );
        }
        if (
          /\bADD (?:CONSTRAINT \S+ )?(FOREIGN KEY|CHECK)\b/i.test(action) &&
          !/\bNOT VALID\b/i.test(action)
        ) {
          problems.push(
            // VALIDATE in the same transaction as the ADD still runs under
            // the ADD's exclusive lock, so it goes in a migration of its own.
            `${file}: a new constraint on ${table} scans it under a lock that blocks writes; add it NOT VALID and VALIDATE CONSTRAINT in a later migration`,
          );
        }
        if (
          /\bADD (?:CONSTRAINT \S+ )?(UNIQUE|PRIMARY KEY)\b/i.test(action) &&
          !/\bUSING INDEX\b/i.test(action)
        ) {
          problems.push(
            `${file}: a new UNIQUE or PRIMARY KEY constraint builds its index on ${table} under an exclusive lock; build the index CONCURRENTLY and add the constraint USING INDEX`,
          );
        }
      }
      const update = statement.match(
        new RegExp(
          `^(?:WITH\\b.*?\\)\\s*)?(UPDATE|DELETE FROM) (?:ONLY )?${qualified}`,
          "i",
        ),
      );
      if (update?.[1] && update[2] && existingGrowing(update[2])) {
        problems.push(
          `${file}: ${update[1].toUpperCase()} on ${update[2]} inside the migration holds its row locks until the whole migration commits; backfill in batches outside it (0170, 0182)`,
        );
      }
    }
  }
  return problems;
}

// Migrations up to this one predate the contract rule; 0270 removed the
// execution profiles with the release that dropped their workers from the
// support window.
const CONTRACT_CHECKED_AFTER_IDX = 273;

// The support window is the current release and the one before it, and a
// release preparation merged before its tag still ships what follows: with
// the newest heading being the release under way, its predecessor's
// control-host still runs on the new schema during the rollout. So the last
// release that used what a migration drops must have two releases after it.
const RELEASES_AFTER_LAST_USE = 2;

const CONTRACT_MARKER =
  /^--\s*contract:\s*(\S+)\s+last used by\s+(v\d+\.\d+\.\d+)\s*$/gm;

type Token = {
  kind: "word" | "quoted" | "string" | "body" | "punct";
  text: string;
};

// Words lowercased, quoted identifiers as written, comments dropped, and a
// dollar-quoted body kept whole so the DDL inside it is read on its own.
function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  while (at < sql.length) {
    const char = sql[at] ?? "";
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    if (sql.startsWith("--", at)) {
      const end = sql.indexOf("\n", at);
      at = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", at)) {
      // PostgreSQL block comments nest.
      let depth = 0;
      do {
        if (sql.startsWith("/*", at)) {
          depth++;
          at += 2;
        } else if (sql.startsWith("*/", at)) {
          depth--;
          at += 2;
        } else {
          at++;
        }
      } while (depth > 0 && at < sql.length);
      continue;
    }
    if (char === '"' || char === "'") {
      // E'...' takes backslash escapes; its E was read as a word just before.
      const previous = out.at(-1);
      const escapes =
        char === "'" &&
        previous?.kind === "word" &&
        previous.text === "e" &&
        /[eE]/.test(sql[at - 1] ?? "");
      if (escapes) {
        out.pop();
      }
      let text = "";
      at++;
      while (at < sql.length) {
        const next = sql[at] ?? "";
        if (escapes && next === "\\") {
          text += sql[at + 1] ?? "";
          at += 2;
        } else if (next === char && sql[at + 1] === char) {
          text += char;
          at += 2;
        } else if (next === char) {
          at++;
          break;
        } else {
          text += next;
          at++;
        }
      }
      out.push({ kind: char === '"' ? "quoted" : "string", text });
      continue;
    }
    const dollar = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(
      sql.slice(at, at + 64),
    );
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, at + tag.length);
      out.push({
        kind: "body",
        text: sql.slice(at + tag.length, end === -1 ? sql.length : end),
      });
      at = end === -1 ? sql.length : end + tag.length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(at, at + 128));
    if (word) {
      out.push({ kind: "word", text: word[0].toLowerCase() });
      at += word[0].length;
      continue;
    }
    out.push({ kind: "punct", text: char });
    at++;
  }
  return out;
}

// Splits at a separator outside parentheses.
function splitAt(tokens: Token[], separator: string): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "punct") {
      if (token.text === "(") {
        depth++;
      } else if (token.text === ")") {
        depth--;
      } else if (token.text === separator && depth === 0) {
        parts.push([]);
        continue;
      }
    }
    parts.at(-1)?.push(token);
  }
  return parts.filter((part) => part.length > 0);
}

const isWord = (token: Token | undefined, ...words: string[]) =>
  token?.kind === "word" && words.includes(token.text);
const isIdentifier = (token: Token | undefined) =>
  token?.kind === "word" || token?.kind === "quoted";
const isPunct = (token: Token | undefined, text: string) =>
  token?.kind === "punct" && token.text === text;

// The index past `words` when they all follow `at`, else `at`.
function past(tokens: Token[], at: number, ...words: string[]): number {
  return words.every((word, offset) => isWord(tokens[at + offset], word))
    ? at + words.length
    : at;
}

type Name = { name: string; schema: string | undefined; next: number };

// A name, schema-qualified or not, and the index after it.
function nameAt(tokens: Token[], at: number): Name | undefined {
  let next = at;
  const parts: string[] = [];
  while (isIdentifier(tokens[next])) {
    parts.push(tokens[next]?.text ?? "");
    next++;
    if (!isPunct(tokens[next], ".")) {
      break;
    }
    next++;
  }
  const name = parts.at(-1);
  return name === undefined ? undefined : { name, schema: parts.at(-2), next };
}

// A table's key: a pair, since a quoted name may itself hold a dot.
const tableKey = (schema: string, name: string) =>
  JSON.stringify([schema, name]);

// The key of the table this migration made that a name reaches, if any. An
// unqualified name reaches a temporary table first, then public.
function madeHere(created: Set<string>, table: Name): string | undefined {
  const reached =
    table.schema === undefined
      ? [tableKey("pg_temp", table.name), tableKey("public", table.name)]
      : [tableKey(table.schema, table.name)];
  return reached.find((key) => created.has(key));
}

type Removal = { target: string; how: string } | { refused: string };

// Tables and columns the statements drop, rename or move away. What this
// cannot follow (a whole schema, SQL assembled in a string) is refused. A
// procedural body (DO, a function) is read like the file, but what it
// creates may never run, so it exempts nothing.
function removals(
  tokens: Token[],
  created: Set<string>,
  inBody: boolean,
): Removal[] {
  const out: Removal[] = [];
  for (const whole of splitAt(tokens, ";")) {
    // DO and CREATE FUNCTION may also carry their body as a quoted string.
    const procedural =
      isWord(whole[0], "do") ||
      (isWord(whole[0], "create") &&
        whole.some((token) => isWord(token, "function", "procedure")));
    for (const token of whole) {
      if (
        token.kind === "body" ||
        (procedural && !inBody && token.kind === "string")
      ) {
        out.push(...removals(tokenize(token.text), created, true));
      } else if (
        inBody &&
        token.kind === "string" &&
        /\b(drop|rename|set\s+schema)\b/i.test(token.text)
      ) {
        out.push({
          refused: `SQL built in a string may drop or rename (${JSON.stringify(token.text.slice(0, 60))}); write it as a plain statement`,
        });
      }
    }
    // In a procedural body a statement may follow BEGIN, THEN, LOOP and such.
    const statement = inBody
      ? whole.slice(
          Math.max(
            0,
            whole.findIndex((token) =>
              isWord(token, "create", "drop", "alter"),
            ),
          ),
        )
      : whole;
    const [first, second] = statement;
    if (isWord(first, "create")) {
      let at = isWord(statement[1], "global", "local") ? 2 : 1;
      const temporary = isWord(statement[at], "temp", "temporary");
      if (temporary || isWord(statement[at], "unlogged")) {
        at++;
      }
      if (!isWord(statement[at], "table")) {
        continue;
      }
      const unless = past(statement, at + 1, "if", "not", "exists");
      const table = nameAt(statement, unless);
      // IF NOT EXISTS may name a table the database already has.
      if (table && !inBody && (temporary || unless === at + 1)) {
        created.add(
          tableKey(
            table.schema ?? (temporary ? "pg_temp" : "public"),
            table.name,
          ),
        );
      }
    } else if (isWord(first, "drop") && isWord(second, "schema")) {
      out.push({
        refused:
          "DROP SCHEMA drops every table in it; drop each table on its own",
      });
    } else if (isWord(first, "drop") && isWord(second, "table")) {
      let at = past(statement, 2, "if", "exists");
      for (
        let table = nameAt(statement, at);
        table;
        table = nameAt(statement, at)
      ) {
        // Once dropped, the same name reaches whatever it hid.
        const made = madeHere(created, table);
        if (made === undefined) {
          out.push({ target: table.name, how: "DROP TABLE" });
        } else {
          created.delete(made);
        }
        if (!isPunct(statement[table.next], ",")) {
          break;
        }
        at = table.next + 1;
      }
    } else if (isWord(first, "alter") && isWord(second, "table")) {
      const table = nameAt(
        statement,
        past(statement, past(statement, 2, "if", "exists"), "only"),
      );
      if (!table) {
        continue;
      }
      const rest = statement.slice(table.next);
      if (isPunct(rest[0], "*")) {
        rest.shift();
      }
      const made = madeHere(created, table);
      if (made !== undefined) {
        // A table this migration made keeps its exemption under the name
        // or schema it moves to, and its old name reaches what it hid.
        let [schema = "public", name = table.name] = JSON.parse(
          made,
        ) as string[];
        for (const action of splitAt(rest, ",")) {
          if (isWord(action[0], "rename") && isWord(action[1], "to")) {
            name = nameAt(action, 2)?.name ?? name;
          } else if (isWord(action[0], "set") && isWord(action[1], "schema")) {
            schema = nameAt(action, 2)?.name ?? schema;
          }
        }
        created.delete(made);
        created.add(tableKey(schema, name));
        continue;
      }
      for (const action of splitAt(rest, ",")) {
        const [verb, object] = action;
        // DROP DEFAULT, NOT NULL and the like belong to ALTER COLUMN, and
        // keep the data like DROP CONSTRAINT and RENAME CONSTRAINT do.
        if (isWord(verb, "drop") && !isWord(object, "constraint")) {
          const column =
            action[past(action, past(action, 1, "column"), "if", "exists")];
          if (isIdentifier(column)) {
            out.push({
              target: `${table.name}.${column?.text}`,
              how: "DROP COLUMN",
            });
          }
        } else if (isWord(verb, "rename") && isWord(object, "to")) {
          out.push({ target: table.name, how: "RENAME TO" });
        } else if (isWord(verb, "rename") && !isWord(object, "constraint")) {
          const column = action[past(action, 1, "column")];
          if (isIdentifier(column)) {
            out.push({
              target: `${table.name}.${column?.text}`,
              how: "RENAME COLUMN",
            });
          }
        } else if (isWord(verb, "set") && isWord(object, "schema")) {
          out.push({ target: table.name, how: "SET SCHEMA" });
        }
      }
    }
  }
  return out;
}

/** Release headings of CHANGELOG.md, newest first. */
export function changelogReleases(
  changelog = join(import.meta.dir, "../../../CHANGELOG.md"),
): string[] {
  return [
    ...readFileSync(changelog, "utf8").matchAll(/^## (v\d+\.\d+\.\d+)$/gm),
  ]
    .map((match) => match[1])
    .filter((release): release is string => release !== undefined);
}

/**
 * A table or column a migration drops or renames must be unused by every
 * release still in the support window, so old code reading it keeps working
 * (docs/contributing/decisions/worker-compat.md § 5). The migration names
 * the last release that used it in a `-- contract: <table>[.<column>] last
 * used by vX.Y.Z` line; that release needs RELEASES_AFTER_LAST_USE newer
 * ones in CHANGELOG.md.
 */
export function contractProblems(
  folder: string,
  releases = changelogReleases(),
  checkedAfterIdx = CONTRACT_CHECKED_AFTER_IDX,
): string[] {
  const problems: string[] = [];
  for (const entry of readJournal(folder)) {
    if (entry.idx <= checkedAfterIdx) {
      continue;
    }
    const file = `${entry.tag}.sql`;
    const raw = readFileSync(join(folder, file), "utf8");
    const lastUse = new Map(
      [...raw.matchAll(CONTRACT_MARKER)].map(([, target, release]) => [
        target,
        release,
      ]),
    );
    for (const removal of removals(tokenize(raw), new Set(), false)) {
      if ("refused" in removal) {
        problems.push(`${file}: ${removal.refused}`);
        continue;
      }
      const { target, how } = removal;
      const release = lastUse.get(target);
      if (release === undefined) {
        problems.push(
          `${file}: ${how} ${target} while a release in the support window may still use it; ` +
            `name the last release that did with "-- contract: ${target} last used by vX.Y.Z"`,
        );
        continue;
      }
      const newer = releases.indexOf(release);
      if (newer === -1) {
        problems.push(
          `${file}: ${target} names ${release}, which is no release heading in CHANGELOG.md`,
        );
      } else if (newer < RELEASES_AFTER_LAST_USE) {
        problems.push(
          `${file}: ${how} ${target} needs ${RELEASES_AFTER_LAST_USE} releases after ${release}, its last user; CHANGELOG.md has ${newer}`,
        );
      }
    }
  }
  return problems;
}
