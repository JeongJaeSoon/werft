import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrationFile } from "../testing/migrations.ts";

/**
 * The provider token clamp, run against the schema just before it with counts
 * 0127 summed uncapped. Found by name so a renumbering restack does not break
 * it.
 */
const migrations = join(import.meta.dir, "../../migrations");

let client: PGlite;
let clamp: string;

const apply = (file: string) => applyMigrationFile(client, file);

async function sessionWith(tokens: string): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch, provider_tokens) VALUES ($1, 'owner-a', 'https://example.invalid/r.git', $2, $3)`,
    [id, `session/${id}`, tokens],
  );
  return id;
}

async function tokensOf(id: string): Promise<string | undefined> {
  const result = await client.query<{ provider_tokens: string }>(
    "SELECT provider_tokens::text AS provider_tokens FROM sessions WHERE id = $1",
    [id],
  );
  return result.rows[0]?.provider_tokens;
}

beforeEach(async () => {
  const files = (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const found = files.find((name) =>
    name.endsWith("_session_provider_tokens_clamp.sql"),
  );
  if (!found)
    throw new Error("session_provider_tokens_clamp migration not found");
  clamp = found;
  client = new PGlite();
  for (const file of files.filter((name) => name < clamp)) {
    await apply(file);
  }
});

afterEach(async () => {
  await client.close();
});

describe("session provider token clamp", () => {
  test("brings a count past 2^53-1 down to it and leaves the rest alone", async () => {
    const over = await sessionWith("9223372036854775807");
    const justOver = await sessionWith("9007199254740992");
    const atCap = await sessionWith("9007199254740991");
    const small = await sessionWith("1234");

    await apply(clamp);

    expect(await tokensOf(over)).toBe("9007199254740991");
    expect(await tokensOf(justOver)).toBe("9007199254740991");
    expect(await tokensOf(atCap)).toBe("9007199254740991");
    expect(await tokensOf(small)).toBe("1234");
  });
});
