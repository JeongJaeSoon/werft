import type { Database } from "@werft-ai/db";
import type { IdentityStore } from "@werft-ai/platform";
import { DatabaseIdentityStore, issueSetupToken } from "../api/auth.ts";

/** The token alone, or null when an owner exists, for the tests' owner. */
export async function issueTestSetupToken(
  store: Pick<IdentityStore, "issueSetupLink">,
  email = "owner@example.com",
): Promise<string | null> {
  return (await issueSetupToken(store, email))?.token ?? null;
}

/** A live setup link's token for `email`, as admin bootstrap-owner issues it. */
export async function liveSetupToken(
  db: Database,
  email = "owner@example.com",
): Promise<string> {
  const issued = await issueSetupToken(new DatabaseIdentityStore(db), email);
  if (issued === null) throw new Error("a live owner exists; no setup link");
  return issued.token;
}
