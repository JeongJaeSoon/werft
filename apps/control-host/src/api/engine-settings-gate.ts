import { setEngineSettingsGate } from "@werft-ai/db";
import { sql } from "drizzle-orm";
import {
  type McpSettingsMigrationDeps,
  openJobDatabase,
} from "./mcp-settings-migration.ts";

const USAGE = [
  "usage:",
  "  engine-settings-gate status",
  "  engine-settings-gate open",
  "  engine-settings-gate close",
].join("\n");

export type GateCommand = "status" | "open" | "close";

export function parseArgs(argv: string[]): GateCommand {
  const [command, ...rest] = argv;
  if (
    rest.length > 0 ||
    (command !== "status" && command !== "open" && command !== "close")
  ) {
    throw new Error(USAGE);
  }
  return command;
}

/** Opening lets the console and API save engine rules; closing stops saves only: rules already stored keep being enforced. */
export async function runEngineSettingsGate(
  argv: string[],
  deps: Pick<McpSettingsMigrationDeps, "db">,
  out: (line: string) => void = console.log,
): Promise<number> {
  const command = parseArgs(argv);
  if (command === "status") {
    const result = await deps.db.execute(
      sql`SELECT writes_open, changed_at FROM engine_settings_gate WHERE id = 1`,
    );
    const rows = (
      Array.isArray(result) ? result : (result as { rows: unknown[] }).rows
    ) as {
      writes_open: boolean;
      changed_at: string;
    }[];
    const row = rows[0];
    out(
      JSON.stringify({
        writes_open: row?.writes_open ?? null,
        changed_at: row?.changed_at ?? null,
      }),
    );
    return row === undefined ? 1 : 0;
  }
  const { before, after } = await setEngineSettingsGate(
    deps.db,
    command === "open",
  );
  out(JSON.stringify({ writes_open_before: before, writes_open: after }));
  return 0;
}

export async function engineSettingsGate(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  out: (line: string) => void = console.log,
): Promise<number> {
  parseArgs(argv);
  const opened = await openJobDatabase("engine-settings-gate", environment);
  try {
    return await runEngineSettingsGate(argv, opened, out);
  } finally {
    await opened.pool.end();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await engineSettingsGate(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
