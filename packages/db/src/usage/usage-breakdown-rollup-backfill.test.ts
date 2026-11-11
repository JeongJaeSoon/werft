import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * The usage breakdown rollup migration, run against the schema just before
 * it with ledger rows already written. Found by name so a renumbering restack
 * does not break it.
 */
const migrations = join(import.meta.dir, "../../migrations");

let client: PGlite;
let rollup: string;

// In one transaction, as drizzle's migrator runs them.
async function apply(file: string): Promise<void> {
  const sql = await readFile(join(migrations, file), "utf8");
  await client.exec("BEGIN");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) await client.exec(statement);
  }
  await client.exec("COMMIT");
}

// An agent with one release, for a session to run under.
async function seedRelease(): Promise<{ agentId: string; releaseId: string }> {
  const workspaceId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const releaseId = crypto.randomUUID();
  await client.query(
    `INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'Acme')`,
    [workspaceId, `acme-${workspaceId}`],
  );
  await client.query(
    `INSERT INTO agents (id, workspace_id, slug, name) VALUES ($1, $2, 'fixer', 'Fixer')`,
    [agentId, workspaceId],
  );
  await client.query(
    `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256) VALUES ($1, $2, 1, '{}', $3)`,
    [versionId, agentId, "0".repeat(64)],
  );
  await client.query(
    `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256, runtime_profile_id, profile_digest, runtime_config_snapshot, effective_tools)
     VALUES ($1, $2, $3, 'card', 'coding', 'digest', '{}', '[]')`,
    [releaseId, agentId, versionId],
  );
  return { agentId, releaseId };
}

async function seedAttempt(
  costUsd: number,
  releaseId: string | null = null,
): Promise<{
  sessionId: string;
  attemptId: string;
}> {
  const sessionId = crypto.randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch, cost_usd, agent_release_id, created_at) VALUES ($1, 'owner-a', 'https://example.invalid/r.git', $2, $3, $4, '2026-10-01T00:00:00Z')`,
    [sessionId, `session/${sessionId}`, costUsd, releaseId],
  );
  const executionId = `exec-${crypto.randomUUID()}`;
  await client.query(
    `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state)
     VALUES ($1, $2, 'local_docker', 1, 'running', 'running')`,
    [executionId, sessionId],
  );
  const attemptId = `att-${crypto.randomUUID()}`;
  await client.query(
    `INSERT INTO attempts (id, session_id, execution_id, lease_epoch, execution_generation, auth_revision, state, lease_expires_at)
     VALUES ($1, $2, $3, 1, 1, 1, 'exited', now())`,
    [attemptId, sessionId, executionId],
  );
  return { sessionId, attemptId };
}

async function seedUsage(
  at: { sessionId: string; attemptId: string },
  model: string,
  tokens: string | number,
  costUsd: number,
): Promise<void> {
  // input, output, cache read and cache write all `tokens`.
  await client.query(
    `INSERT INTO provider_usage (exchange_id, session_id, attempt_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_creation_1h_input_tokens, cache_read_input_tokens, estimated, cost_usd, priced_by)
     VALUES ($1, $2, $3, $4, $5, $5, $5, 0, $5, false, $6, 'table')`,
    [crypto.randomUUID(), at.sessionId, at.attemptId, model, tokens, costUsd],
  );
}

async function providerTokensOf(sessionId: string) {
  const result = await client.query<{ provider_tokens: string }>(
    `SELECT provider_tokens::text FROM sessions WHERE id = $1`,
    [sessionId],
  );
  return result.rows[0]?.provider_tokens;
}

async function preMeteringOf(sessionId: string) {
  const result = await client.query<Record<string, string>>(
    `SELECT session_created_at::text, cost_usd::text
     FROM session_pre_metering_cost WHERE session_id = $1`,
    [sessionId],
  );
  return result.rows[0];
}

async function pairsOf(sessionId: string) {
  const result = await client.query<Record<string, string | null>>(
    `SELECT model, session_created_at::text, agent_id::text, input_tokens::text, output_tokens::text,
            cache_read_input_tokens::text, cache_creation_input_tokens::text, cost_usd::text
     FROM session_model_usage WHERE session_id = $1 ORDER BY model`,
    [sessionId],
  );
  return result.rows;
}

beforeEach(async () => {
  const files = (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const found = files.find((name) =>
    name.endsWith("_usage_breakdown_rollup.sql"),
  );
  if (!found) throw new Error("usage_breakdown_rollup migration not found");
  rollup = found;
  client = new PGlite();
  for (const file of files.filter((name) => name < rollup)) {
    await apply(file);
  }
});

afterEach(async () => {
  await client.close();
});

describe("usage breakdown rollup migration", () => {
  test("sums each session's calls by model under its agent, and keeps the cost no call explains", async () => {
    const release = await seedRelease();
    const metered = await seedAttempt(0.6, release.releaseId);
    await seedUsage(metered, "claude-opus-5-5", 10, 0.25);
    await seedUsage(metered, "claude-opus-5-5", 1, 0.25);
    await seedUsage(metered, "claude-sonnet-5-5", 100, 0.1);
    // Engine totals before metering, then a metered call.
    const mixed = await seedAttempt(1.5);
    await seedUsage(mixed, "claude-sonnet-5-5", 2, 0.5);
    const legacy = await seedAttempt(2);
    const free = await seedAttempt(0);

    await apply(rollup);

    expect(await providerTokensOf(metered.sessionId)).toBe("444");
    expect(await pairsOf(metered.sessionId)).toEqual([
      {
        model: "claude-opus-5-5",
        session_created_at: "2026-10-01 00:00:00+00",
        agent_id: release.agentId,
        input_tokens: "11",
        output_tokens: "11",
        cache_read_input_tokens: "11",
        cache_creation_input_tokens: "11",
        cost_usd: "0.500000",
      },
      {
        model: "claude-sonnet-5-5",
        session_created_at: "2026-10-01 00:00:00+00",
        agent_id: release.agentId,
        input_tokens: "100",
        output_tokens: "100",
        cache_read_input_tokens: "100",
        cache_creation_input_tokens: "100",
        cost_usd: "0.100000",
      },
    ]);
    expect(await preMeteringOf(metered.sessionId)).toBeUndefined();
    expect(await pairsOf(mixed.sessionId)).toMatchObject([
      { model: "claude-sonnet-5-5", agent_id: null, input_tokens: "2" },
    ]);
    expect(await preMeteringOf(mixed.sessionId)).toEqual({
      session_created_at: "2026-10-01 00:00:00+00",
      cost_usd: "1.000000",
    });
    expect(await pairsOf(legacy.sessionId)).toEqual([]);
    expect((await preMeteringOf(legacy.sessionId))?.cost_usd).toBe("2.000000");
    expect(await preMeteringOf(free.sessionId)).toBeUndefined();
  });

  test("a call recorded after the migration counts in the session and its model's row", async () => {
    const release = await seedRelease();
    const session = await seedAttempt(0.5, release.releaseId);
    await seedUsage(session, "claude-opus-5-5", 10, 0.5);
    await apply(rollup);

    await seedUsage(session, "claude-opus-5-5", 5, 0.25);
    await seedUsage(session, "claude-haiku-5-5", 1, 0.01);

    expect(await providerTokensOf(session.sessionId)).toBe("64");
    expect(
      (await pairsOf(session.sessionId)).map((row) => [
        row.model,
        row.agent_id,
        row.input_tokens,
        row.cost_usd,
      ]),
    ).toEqual([
      ["claude-haiku-5-5", release.agentId, "1", "0.010000"],
      ["claude-opus-5-5", release.agentId, "15", "0.750000"],
    ]);
    expect(await preMeteringOf(session.sessionId)).toBeUndefined();
  });

  test("counts stop at the largest safe integer however much is recorded", async () => {
    const session = await seedAttempt(0);
    // bigint's own maximum, before and after: the backfill clamps one call,
    // the trigger the sum of two.
    await seedUsage(session, "claude-opus-5-5", "9223372036854775807", 0);
    await apply(rollup);
    const max = String(Number.MAX_SAFE_INTEGER);
    expect((await pairsOf(session.sessionId))[0]).toMatchObject({
      input_tokens: max,
      cache_creation_input_tokens: max,
    });
    await seedUsage(session, "claude-opus-5-5", "9223372036854775807", 0);
    expect(await providerTokensOf(session.sessionId)).toBe(max);
    expect((await pairsOf(session.sessionId))[0]).toMatchObject({
      input_tokens: max,
      output_tokens: max,
    });
  });
});
