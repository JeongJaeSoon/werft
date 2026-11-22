// `bun run setup-link`: print a one-time link that makes the first owner,
// only while the install has no live owner (first install, or every owner
// lost). The link goes to stdout and nowhere else; the API never logs it.

import { SETUP_LINK_TTL_HOURS } from "@werft-ai/contracts";
import { createLogger } from "@werft-ai/observability";
import { withJobDatabase } from "../job-database.ts";
import {
  DatabaseIdentityStore,
  issueSetupToken,
  setupLinkPath,
} from "./auth.ts";

/** The whole link when the console's origin is known, else its path. */
export function setupLinkText(path: string, consoleOrigin?: string): string {
  return consoleOrigin ? `${consoleOrigin.replace(/\/+$/, "")}${path}` : path;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }
  await withJobDatabase(
    "setup-link",
    databaseUrl,
    createLogger(),
    async ({ db }) => {
      const token = await issueSetupToken(new DatabaseIdentityStore(db));
      if (token === null) {
        console.error(
          "A live owner exists, so no setup link is issued. An owner invites people from the console.",
        );
        process.exitCode = 1;
        return;
      }
      const consoleOrigin = process.env.CONSOLE_ORIGIN || undefined;
      // stdout carries the link alone so scripts can capture it.
      console.error(
        `Open this link to create the first owner. It works once, for ${SETUP_LINK_TTL_HOURS} hours; running this again replaces it.` +
          (consoleOrigin ? "" : " Open it on the console's address."),
      );
      console.log(setupLinkText(setupLinkPath(token), consoleOrigin));
    },
  );
}

if (import.meta.main) {
  await main();
}
