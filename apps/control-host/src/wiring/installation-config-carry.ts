// Migrate runs this after the schema migration and before any role starts,
// so every role reads the same installation settings: none of them reads the
// old env variables.
//
//   bun run apps/control-host/src/wiring/installation-config-carry.ts
import { createPostgresInstallationConfigStore } from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import { withJobDatabase } from "../job-database.ts";
import { carryInstallationConfig } from "./installation-config.ts";

async function main(): Promise<void> {
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await withJobDatabase(
    "installation-config-carry",
    databaseUrl,
    createLogger(),
    async ({ db }) => {
      const { warnings } = await carryInstallationConfig(
        process.env,
        createPostgresInstallationConfigStore(db),
      );
      for (const warning of warnings)
        process.stderr.write(`note: ${warning}\n`);
    },
  );
}

if (import.meta.main) {
  await main();
}
