import type { Database } from "../queries.ts";
import { providerConnections } from "../schema.ts";

/**
 * An enabled openai_decisions connection, the installation's decision model:
 * without one no achievement judgment is queued.
 */
export async function insertDecisionModel(
  db: Database,
  id = "luna-main",
): Promise<void> {
  await db
    .insert(providerConnections)
    .values({
      id,
      definition: {
        kind: "openai_decisions",
        endpoint: "https://api.openai.com",
        auth: { kind: "api_key", stored: `connection:${id}` },
      },
      credentialSource: "stored",
      origin: "import",
    })
    .onConflictDoNothing();
}
