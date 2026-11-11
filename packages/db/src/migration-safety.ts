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
