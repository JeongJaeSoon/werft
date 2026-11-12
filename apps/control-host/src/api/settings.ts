import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPostgresSettingsDocumentStore } from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  messageOf,
  parseSettingsDocument,
  type SettingsDocument,
  type SettingsDocumentStore,
  type SettingsEntries,
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
  withoutLegacyRepositories,
} from "./settings-from-dir.ts";

// The operator's settings import and export
// (docs/contributing/decisions/settings-replace-file-catalog.md §5, §6).
// Run where keys.ts runs, against the database: unlike the API's import it
// may bring in env and Secrets Manager references, since whoever reaches
// the database already holds the deployment.
const USAGE = `Usage: bun run apps/control-host/src/api/settings.ts export
       bun run apps/control-host/src/api/settings.ts import --document <file|-> [--dry-run]
       bun run apps/control-host/src/api/settings.ts import --from-dir <dir> [--if-present] [--dry-run]`;

export type SettingsCommand =
  | { command: "export" }
  | {
      command: "import";
      source: { document: string } | { dir: string; ifPresent: boolean };
      dryRun: boolean;
    };

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
  if (command !== "import") throw new Error(USAGE);
  const document = values.document;
  const dir = values["from-dir"];
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
 * repositories.yaml and mcp-servers.yaml under their own rules. A
 * profiles.yaml is not read: profiles are gone, and a connection lists the
 * models agents may pick.
 */
export async function documentFromDir(dir: string): Promise<{
  document: SettingsDocument;
  notes: string[];
  skipped: string[];
}> {
  const notes: string[] = [];
  const skipped: string[] = [];
  const config = await readCatalogConfig(dir, notes, skipped);
  const entries: SettingsEntries = {
    connections: { ...(await readConnections(dir)) },
    repositories: config.repositories,
    mcp_servers: config.mcp_servers ?? {},
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
    throw new Error(`${path} is missing`);
  }
  try {
    return JSON.parse(await file.text());
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${messageOf(error)}`);
  }
}

type Output = { out: (line: string) => void; err: (line: string) => void };

type SettingsStores = {
  settings: Pick<
    SettingsDocumentStore,
    "exportEntries" | "importEntries" | "sessionsOnRepositories"
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
  const { source } = command;
  let entries: SettingsEntries;
  let skipped: string[] = [];
  if ("dir" in source) {
    if (source.ifPresent && (await dirIsEmpty(source.dir))) {
      output.err(`nothing to import from ${source.dir}`);
      return true;
    }
    const read = await documentFromDir(source.dir);
    for (const note of read.notes) output.err(`note: ${note}`);
    skipped = read.skipped;
    entries = parseSettingsDocument(read.document);
  } else {
    const document = await readDocument(source.document);
    const notes: string[] = [];
    entries = parseSettingsDocument(
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
  }
  // A session on a repository only the file knew would be failed by the
  // claim gate with nothing to hold it: stop before anything is written.
  const stranded = await stores.settings.sessionsOnRepositories(skipped);
  if (stranded.length > 0) {
    output.err(
      `refused: nothing changed; sessions still use repositories this import leaves out: ${stranded
        .map((row) => `${row.session_id} (${row.repository_id}, ${row.via})`)
        .join(", ")}`,
    );
    return false;
  }
  const result = await stores.settings.importEntries(entries, {
    dryRun: command.dryRun,
    allowExternal: true,
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
  for (const ref of result.kept ?? []) {
    output.err(
      `note: ${ref} from the file is not applied; the database keeps its row`,
    );
  }
  output.out(JSON.stringify(result, null, 2));
  if (result.outcome === "applied" && result.receipt_ids.length === 0) {
    if (result.add.length > 0) {
      output.err("note: no workspace yet, so no receipt was written");
    }
  }
  return true;
}

async function main(): Promise<void> {
  const command = parseSettingsCommand(Bun.argv.slice(2));
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
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
}

if (import.meta.main) {
  await main();
}
