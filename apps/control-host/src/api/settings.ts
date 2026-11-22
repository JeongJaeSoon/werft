import { parseArgs } from "node:util";
import { createPostgresSettingsDocumentStore } from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  messageOf,
  parseSettingsDocument,
  SettingsDocumentError,
  type SettingsDocumentStore,
  type SettingsSeedDecision,
  settingsDocumentDigest,
  settingsDocumentOf,
} from "@werft-ai/platform";
import { withJobDatabase } from "../job-database.ts";

// The operator's settings import and export, and migrate's seed of an empty
// installation.
// Run where keys.ts runs, against the database. Its entries name `stored`
// as the API's do; each value is set in the console or through the API.
const USAGE = `Usage: bun run apps/control-host/src/api/settings.ts export
       bun run apps/control-host/src/api/settings.ts import --document <file|-> [--dry-run]
       bun run apps/control-host/src/api/settings.ts seed --document <file|->`;

/**
 * An input file the operator named is missing or malformed: theirs to fix,
 * so the CLI prints the message without a stack.
 */
export class SettingsFileError extends Error {
  override name = "SettingsFileError";
}

export type SettingsCommand =
  | { command: "export" }
  | { command: "import"; document: string; dryRun: boolean }
  /**
   * migrate's: the first deploy of an empty installation imports the
   * document; every later one imports nothing.
   */
  | { command: "seed"; document: string };

export function parseSettingsCommand(argv: string[]): SettingsCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new Error(`${messageOf(error)}\n${USAGE}`);
  }
  const { positionals, values } = parsed;
  const [command, ...extra] = positionals;
  if (extra.length > 0) throw new Error(USAGE);
  const { document } = values;
  if (command === "export") {
    if (document !== undefined || values["dry-run"] !== undefined) {
      throw new Error(USAGE);
    }
    return { command };
  }
  if (command !== "import" && command !== "seed") throw new Error(USAGE);
  if (document === undefined) throw new Error(`name --document\n${USAGE}`);
  if (command === "seed") {
    if (values["dry-run"] !== undefined) throw new Error(USAGE);
    return { command, document };
  }
  return { command, document, dryRun: values["dry-run"] === true };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      document: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}

/** `-` is stdin: the document reaches a container through `exec -T`. */
async function readDocument(path: string): Promise<unknown> {
  const file = path === "-" ? Bun.stdin : Bun.file(path);
  if (path !== "-" && !(await file.exists())) {
    throw new SettingsFileError(`${path} is missing`);
  }
  try {
    return JSON.parse(await file.text());
  } catch (error) {
    throw new SettingsFileError(
      `${path} is not valid JSON: ${messageOf(error)}`,
    );
  }
}

type Output = { out: (line: string) => void; err: (line: string) => void };

type SettingsStores = {
  settings: Pick<
    SettingsDocumentStore,
    "exportEntries" | "importEntries" | "decideSeed" | "seedEntries"
  >;
};

export async function runSettingsCommand(
  command: SettingsCommand,
  stores: SettingsStores,
  output: Output,
): Promise<boolean> {
  if (command.command === "export") {
    const { entries, last4 } = await stores.settings.exportEntries();
    const document = settingsDocumentOf(entries, last4);
    output.out(JSON.stringify(document, null, 2));
    output.err(`digest ${settingsDocumentDigest(document)}`);
    return true;
  }
  if (command.command === "seed") return seed(command, stores, output);
  const entries = parseSettingsDocument(await readDocument(command.document));
  const result = await stores.settings.importEntries(entries, {
    dryRun: command.dryRun,
    actor: null,
  });
  if (result.outcome === "actor_inactive") {
    throw new Error("the operator's import has no actor to lose");
  }
  if (result.outcome === "refused") {
    output.out(JSON.stringify(result, null, 2));
    output.err(
      `refused: nothing changed (conflicts: ${result.conflicts.join(", ") || "none"})`,
    );
    return false;
  }
  output.out(JSON.stringify(result, null, 2));
  if (result.outcome === "applied" && result.receipt_ids.length === 0) {
    if (result.add.length > 0) {
      output.err("note: no workspace yet, so no receipt was written");
    }
  }
  return true;
}

async function seed(
  command: Extract<SettingsCommand, { command: "seed" }>,
  stores: SettingsStores,
  output: Output,
): Promise<boolean> {
  const named = `the settings document ${command.document} (SETTINGS_DOCUMENT)`;
  const notSeeded = (
    decision: Exclude<SettingsSeedDecision, { outcome: "empty" }>,
  ) =>
    output.err(
      `note: ${named} not imported: ${
        decision.outcome === "decided"
          ? `the automatic seed ran on ${decision.decided_at.toISOString()}`
          : "the installation already holds settings"
      }. It seeds an empty installation only; change settings in the console`,
    );
  // Decided before the document is read: one the installation no longer
  // takes need not parse, nor even be readable.
  const decision = await stores.settings.decideSeed();
  if (decision.outcome !== "empty") {
    notSeeded(decision);
    return true;
  }
  const entries = parseSettingsDocument(await readDocument(command.document));
  const result = await stores.settings.seedEntries([{ entries }]);
  if (result.outcome === "decided" || result.outcome === "not_empty") {
    notSeeded(result);
    return true;
  }
  if (result.outcome === "refused") {
    output.out(JSON.stringify(result, null, 2));
    output.err(
      `refused: nothing changed (the settings document conflicts: ${result.conflicts.join(", ") || "none"})`,
    );
    return false;
  }
  output.out(JSON.stringify(result, null, 2));
  if (
    result.receipt_ids.length === 0 &&
    result.steps.some((plan) => plan.add.length > 0)
  ) {
    output.err("note: no workspace yet, so no receipt was written");
  }
  output.err(
    `seeded from ${named}; from here on settings are changed in the console`,
  );
  return true;
}

async function main(): Promise<void> {
  let command: SettingsCommand;
  try {
    command = parseSettingsCommand(Bun.argv.slice(2));
  } catch (error) {
    // An operator's typo, not a crash: the message and usage, no stack.
    console.error(messageOf(error));
    process.exitCode = 1;
    return;
  }
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }
  try {
    await withJobDatabase(
      "settings",
      databaseUrl,
      createLogger(),
      async ({ db }) => {
        const ok = await runSettingsCommand(
          command,
          {
            settings: createPostgresSettingsDocumentStore(db),
          },
          {
            out: (line) => process.stdout.write(`${line}\n`),
            err: (line) => process.stderr.write(`${line}\n`),
          },
        );
        if (!ok) process.exitCode = 1;
      },
    );
  } catch (error) {
    const refusal = inputRefusal(error);
    if (refusal === undefined) throw error;
    console.error(refusal);
    process.exitCode = 1;
  }
}

/**
 * A wrong input file is the operator's to fix: its message, no stack.
 * Anything else is a fault and keeps its stack (undefined).
 */
export function inputRefusal(error: unknown): string | undefined {
  return error instanceof SettingsFileError ||
    error instanceof SettingsDocumentError
    ? error.message
    : undefined;
}

if (import.meta.main) {
  await main();
}
