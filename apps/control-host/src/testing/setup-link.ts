import type { Database } from "@werft-ai/db";
import { DatabaseIdentityStore, issueSetupToken } from "../api/auth.ts";

/** A live setup link's token, as the setup-link command would issue it. */
export async function liveSetupToken(db: Database): Promise<string> {
  const token = await issueSetupToken(new DatabaseIdentityStore(db));
  if (token === null) throw new Error("a live owner exists; no setup link");
  return token;
}
