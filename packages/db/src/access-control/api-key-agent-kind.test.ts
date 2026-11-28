import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrationFile } from "../testing/migrations.ts";

const migrations = join(import.meta.dir, "../../migrations");

let client: PGlite;
let target: string;

const apply = (file: string) => applyMigrationFile(client, file);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USER = "019a0000-0000-7000-8000-0000000000c1";
const AGENT = "019a0000-0000-7000-8000-0000000000d1";

async function seedKey(values: Record<string, string | null>): Promise<string> {
  const id = crypto.randomUUID();
  const columns = ["id", "key_hash", "scopes", ...Object.keys(values)];
  const params = [id, ...Object.values(values)];
  await client.query(
    `INSERT INTO api_keys (${columns.join(", ")}) VALUES ($1, sha256(convert_to(gen_random_uuid()::text, 'UTF8')), ARRAY['sessions:read'], ${Object.keys(
      values,
    )
      .map((_, i) => `$${i + 2}`)
      .join(", ")})`,
    params,
  );
  return id;
}

async function seedSession(keyId: string): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, workspace_id, repo_url, branch, created_by_api_key_id) VALUES ($1, $2::text, $2::uuid, 'https://example.invalid/r.git', 'main', $3)`,
    [id, WORKSPACE, keyId],
  );
  return id;
}

beforeEach(async () => {
  const files = (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const found = files.find((name) => name.endsWith("_api_key_agent_kind.sql"));
  if (!found) throw new Error("api_key_agent_kind migration not found");
  target = found;
  client = new PGlite();
  for (const file of files.filter((name) => name < target)) {
    await apply(file);
  }
  await client.query(
    `INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'Acme')`,
    [WORKSPACE],
  );
  await client.query(
    `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'a@example.com', 'x', 'A')`,
    [USER],
  );
  await client.query(
    `INSERT INTO agents (id, workspace_id, slug, name) VALUES ($1, $2, 'bot', 'Bot')`,
    [AGENT, WORKSPACE],
  );
});

afterEach(async () => {
  await client.close();
});

describe("0163: every key becomes a person's, an agent's or the CLI's", () => {
  test("a bound key becomes the agent's, an unbound one outside workspaces the CLI's, and keys across a workspace go with their sessions kept", async () => {
    const service = { kind: "service", workspace_id: WORKSPACE };
    const agentKey = await seedKey({
      ...service,
      owner_id: WORKSPACE,
      agent_id: AGENT,
    });
    const workspaceKey = await seedKey({ ...service, owner_id: WORKSPACE });
    const operator = await seedKey({ kind: "service", owner_id: "owner-a" });
    // The CLI's old `keys create <workspace id>`: no workspace column, but a
    // workspace's partition all the same. Partitions compare case-sensitively,
    // so the upper-cased id is a partition of its own.
    const onWorkspace = await seedKey({ kind: "service", owner_id: WORKSPACE });
    const upperCased = await seedKey({
      kind: "service",
      owner_id: WORKSPACE.toUpperCase(),
    });
    const personal = await seedKey({
      kind: "personal",
      owner_id: WORKSPACE,
      workspace_id: WORKSPACE,
      created_by_user_id: USER,
    });
    const orphaned = await seedSession(workspaceKey);
    const kept = await seedSession(agentKey);

    await apply(target);

    const keys = await client.query<{ id: string; kind: string; name: null }>(
      "SELECT id, kind, name FROM api_keys",
    );
    expect(
      Object.fromEntries(
        keys.rows.map((row) => [row.id, [row.kind, row.name]]),
      ),
    ).toEqual({
      [agentKey]: ["agent", null],
      [operator]: ["operator", null],
      [upperCased]: ["operator", null],
      [personal]: ["personal", null],
    });
    expect(keys.rows.map((row) => row.id)).not.toContain(onWorkspace);
    const sessions = await client.query<{
      id: string;
      created_by_api_key_id: string | null;
    }>("SELECT id, created_by_api_key_id FROM sessions");
    expect(
      Object.fromEntries(
        sessions.rows.map((row) => [row.id, row.created_by_api_key_id]),
      ),
    ).toEqual({ [orphaned]: null, [kept]: agentKey });
  });

  test("the table then refuses a key across a workspace, an unbound agent key and a blank name", async () => {
    await apply(target);
    const refused = async (values: Record<string, string | null>) => {
      const error = await seedKey(values).then(
        () => undefined,
        (caught: unknown) => caught as { code?: string },
      );
      return error?.code;
    };
    const inWorkspace = { owner_id: WORKSPACE, workspace_id: WORKSPACE };
    expect(await refused({ ...inWorkspace, kind: "service" })).toBe("23514");
    expect(await refused({ ...inWorkspace, kind: "agent" })).toBe("23514");
    expect(await refused({ ...inWorkspace, kind: "operator" })).toBe("23514");
    expect(await refused({ ...inWorkspace, owner_id: "x" })).toBe("23502");
    expect(
      await refused({
        ...inWorkspace,
        kind: "agent",
        agent_id: AGENT,
        name: " x",
      }),
    ).toBe("23514");
    expect(
      await refused({
        ...inWorkspace,
        kind: "agent",
        agent_id: AGENT,
        name: "ci",
      }),
    ).toBeUndefined();
  });
});
