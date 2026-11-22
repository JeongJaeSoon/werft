import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPostgresSettingsDocumentStore } from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  messageOf,
  parseSettingsDocument,
  refuseCatalogMcp,
  type SettingsDocument,
  SettingsDocumentError,
  type SettingsDocumentStore,
  type SettingsEntries,
  type SettingsSeedDecision,
  type SettingsSeedStep,
  settingsDocumentDigest,
  settingsDocumentOf,
} from "@werft-ai/platform";
import { withJobDatabase } from "../job-database.ts";
import {
  dirIsEmpty,
  PLATFORM_FILE,
  PROFILES_FILE,
  readCatalogConfig,
  readConnections,
  SettingsFileError,
  withoutLegacyRepositories,
} from "./settings-from-dir.ts";

// The operator's settings import and export, and migrate's seed of an empty
// installation.
// Run where keys.ts runs, against the database. Its entries name `stored`
// as the API's do; each value is set in the console or through the API.
const USAGE = `Usage: bun run apps/control-host/src/api/settings.ts export
       bun run apps/control-host/src/api/settings.ts import --document <file|-> [--dry-run]
       bun run apps/control-host/src/api/settings.ts import --from-dir <dir> [--if-present] [--dry-run]
       bun run apps/control-host/src/api/settings.ts seed [--from-dir <dir>] [--document <file|->]`;

export type SettingsCommand =
  | { command: "export" }
  | {
      command: "import";
      source: { document: string } | { dir: string; ifPresent: boolean };
      dryRun: boolean;
    }
  /**
   * migrate's: the first deploy of an empty installation imports both, a
   * missing or empty directory skipped; every later one imports nothing.
   */
  | { command: "seed"; dir?: string; document?: string };

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
  if (command === "export") {
    if (
      values.document !== undefined ||
      values["from-dir"] !== undefined ||
      values["dry-run"] !== undefined ||
      values["if-present"] !== undefined
    ) {
      throw new Error(USAGE);
    }
    return { command };
  }
  const document = values.document;
  const dir = values["from-dir"];
  if (command === "seed") {
    if (values["dry-run"] !== undefined || values["if-present"] !== undefined) {
      throw new Error(USAGE);
    }
    if (document === undefined && dir === undefined) {
      throw new Error(`name --document, --from-dir or both\n${USAGE}`);
    }
    return {
      command,
      ...(dir === undefined ? {} : { dir }),
      ...(document === undefined ? {} : { document }),
    };
  }
  if (command !== "import") throw new Error(USAGE);
  if ((document === undefined) === (dir === undefined)) {
    throw new Error(`name one of --document or --from-dir\n${USAGE}`);
  }
  const ifPresent = values["if-present"] === true;
  if (ifPresent && dir === undefined) {
    throw new Error(`--if-present goes with --from-dir\n${USAGE}`);
  }
  return {
    command,
    source:
      document !== undefined ? { document } : { dir: dir as string, ifPresent },
    dryRun: values["dry-run"] === true,
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      document: { type: "string" },
      "from-dir": { type: "string" },
      "if-present": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}

/**
 * The old catalog directory as a settings document: connections.yaml,
 * repositories.yaml under their own rules, and mcp-servers.yaml only to be
 * refused when it names a server. A profiles.yaml is not read: profiles are
 * gone, and a connection lists the models agents may pick.
 */
export async function documentFromDir(dir: string): Promise<{
  document: SettingsDocument;
  notes: string[];
  skipped: string[];
}> {
  const notes: string[] = [];
  const skipped: string[] = [];
  const config = await readCatalogConfig(dir, notes, skipped);
  // The directory becomes a document, so it is refused as one would be.
  refuseCatalogMcp(Object.keys(config.mcp_servers ?? {}));
  const entries: SettingsEntries = {
    connections: { ...(await readConnections(dir)) },
    repositories: config.repositories,
  };
  if (await Bun.file(resolve(dir, PLATFORM_FILE)).exists()) {
    notes.push(
      `${PLATFORM_FILE} is not imported: set the master key in PLATFORM_SECRET_KEY`,
    );
  }
  if (await Bun.file(resolve(dir, PROFILES_FILE)).exists()) {
    notes.push(
      `${PROFILES_FILE} is not imported: profiles are removed; list each connection's models in the console or under connections.<id>.models`,
    );
  }
  return { document: settingsDocumentOf(entries), notes, skipped };
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
    | "exportEntries"
    | "importEntries"
    | "sessionsOnRepositories"
    | "decideSeed"
    | "seedEntries"
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
  const { source } = command;
  if ("dir" in source && source.ifPresent && (await dirIsEmpty(source.dir))) {
    output.err(`nothing to import from ${source.dir}`);
    return true;
  }
  const { entries, skipped } = await readSource(source, output);
  if (await strandedBy(skipped, stores, output)) return false;
  const result = await stores.settings.importEntries(entries, {
    dryRun: command.dryRun,
    ...("dir" in source ? { databaseOwnsRepositories: true } : {}),
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
  keptNotes(result, output);
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
  type Source = { dir: string } | { document: string };
  const nameOf = (sources: Source[]) =>
    sources
      .map((source) =>
        "dir" in source
          ? source.dir
          : `the settings document ${source.document} (SETTINGS_DOCUMENT)`,
      )
      .join(" and ");
  const given: Source[] = [
    ...(command.dir === undefined ? [] : [{ dir: command.dir }]),
    ...(command.document === undefined ? [] : [{ document: command.document }]),
  ];
  const notSeeded = (
    decision: Exclude<SettingsSeedDecision, { outcome: "empty" }>,
  ) =>
    output.err(
      `note: ${nameOf(given)} not imported: ${
        decision.outcome === "decided"
          ? `the automatic seed ran on ${decision.decided_at.toISOString()}`
          : "the installation already holds settings"
      }. They seed an empty installation only; change settings in the console`,
    );
  // Decided before anything is touched: an installation that holds settings
  // gets its marker even with no input, and inputs it no longer takes need
  // not parse, nor even be readable.
  const decision = await stores.settings.decideSeed();
  if (decision.outcome !== "empty") {
    notSeeded(decision);
    return true;
  }
  const sources: Source[] = [];
  for (const source of given) {
    if (!("dir" in source) || !(await dirIsEmpty(source.dir))) {
      sources.push(source);
    }
  }
  if (sources.length === 0) {
    output.err("nothing to seed");
    return true;
  }
  const named = nameOf(sources);
  const steps: SettingsSeedStep[] = [];
  const skipped: string[] = [];
  for (const source of sources) {
    const read = await readSource(source, output);
    steps.push({
      entries: read.entries,
      databaseOwnsRepositories: "dir" in source,
    });
    skipped.push(...read.skipped);
  }
  if (await strandedBy(skipped, stores, output)) return false;
  const result = await stores.settings.seedEntries(steps);
  if (result.outcome === "decided" || result.outcome === "not_empty") {
    notSeeded(result);
    return true;
  }
  if (result.outcome === "refused") {
    const source = sources[result.step];
    output.out(JSON.stringify(result, null, 2));
    output.err(
      `refused: nothing changed (${
        source !== undefined && "dir" in source
          ? source.dir
          : "the settings document"
      } conflicts: ${result.conflicts.join(", ") || "none"})`,
    );
    return false;
  }
  for (const plan of result.steps) keptNotes(plan, output);
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

async function readSource(
  source: { dir: string } | { document: string },
  output: Output,
): Promise<{ entries: SettingsEntries; skipped: string[] }> {
  if ("dir" in source) {
    const read = await documentFromDir(source.dir);
    for (const note of read.notes) output.err(`note: ${note}`);
    return {
      entries: parseSettingsDocument(read.document),
      skipped: read.skipped,
    };
  }
  const document = await readDocument(source.document);
  const notes: string[] = [];
  const skipped: string[] = [];
  const entries = parseSettingsDocument(
    document !== null &&
      typeof document === "object" &&
      !Array.isArray(document) &&
      Object.hasOwn(document, "repositories")
      ? {
          ...document,
          repositories: withoutLegacyRepositories(
            (document as { repositories: unknown }).repositories,
            notes,
            skipped,
          ),
        }
      : document,
  );
  for (const note of notes) output.err(`note: ${note}`);
  return { entries, skipped };
}

/**
 * A session on a repository only the file knew would be failed by the
 * claim gate with nothing to hold it: stop before anything is written.
 */
async function strandedBy(
  skipped: string[],
  stores: SettingsStores,
  output: Output,
): Promise<boolean> {
  const stranded = await stores.settings.sessionsOnRepositories(skipped);
  if (stranded.length === 0) return false;
  output.err(
    `refused: nothing changed; sessions still use repositories this import leaves out: ${stranded
      .map((row) => `${row.session_id} (${row.repository_id}, ${row.via})`)
      .join(", ")}`,
  );
  return true;
}

function keptNotes(plan: { kept?: string[] }, output: Output): void {
  for (const ref of plan.kept ?? []) {
    output.err(
      `note: ${ref} from the file is not applied; the database keeps its row`,
    );
  }
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
