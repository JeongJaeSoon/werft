import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  ADMISSION_STATE_VALUES,
  CREDENTIAL_REF_PATTERN as CONTRACT_CREDENTIAL_REF_PATTERN,
  CREDENTIAL_BINDING_TARGET_VALUES,
  RECEIPT_STATUS_VALUES,
  SESSION_STATUS_VALUES,
} from "@werft-ai/contracts";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import {
  admissionState,
  CREDENTIAL_BINDING_TARGETS,
  CREDENTIAL_REF_PATTERN,
  checkpoints,
  events,
  idempotencyKeys,
  receiptStatus,
  receipts,
  sessionStatus,
  sessions,
} from "./schema.ts";

const databases: PGlite[] = [];

async function migratedDatabase() {
  const client = new PGlite();
  databases.push(client);
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
  return { client, db };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("database schema", () => {
  test("uses the contract session status values", () => {
    expect(sessionStatus.enumValues).toEqual([...SESSION_STATUS_VALUES]);
    expect(CREDENTIAL_BINDING_TARGETS).toEqual(
      CREDENTIAL_BINDING_TARGET_VALUES,
    );
    expect(CREDENTIAL_REF_PATTERN).toBe(CONTRACT_CREDENTIAL_REF_PATTERN);
  });

  test("uses the contract admission and receipt status values", () => {
    expect(admissionState.enumValues).toEqual([...ADMISSION_STATE_VALUES]);
    expect(receiptStatus.enumValues).toEqual([...RECEIPT_STATUS_VALUES]);
  });

  test("applies the migration twice without changing the schema", async () => {
    const { client, db } = await migratedDatabase();
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });

    const result = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(result.rows.map(({ tablename }) => tablename)).toEqual([
      "achievement_categories",
      "achievement_judgment_usage",
      "achievement_judgments",
      "achievement_rules",
      "achievement_types",
      "agent_activation_events",
      "agent_admin_teams",
      "agent_admins",
      "agent_github_settings",
      "agent_identities",
      "agent_mcp_settings",
      "agent_pull_request_settings",
      "agent_releases",
      "agent_versions",
      "agents",
      "api_keys",
      "approval_checkpoint_voids",
      "approval_checkpoints",
      "attempts",
      "authz_decisions",
      "bootstrap_token_uses",
      "catalog_authority",
      "catalog_repositories",
      "catalog_repository_github_apps",
      "checkpoint_output_objects",
      "checkpoint_output_totals",
      "checkpoint_outputs",
      "checkpoints",
      "control_intents",
      "credential_bindings",
      "events",
      "executions",
      "github_app_manifest_states",
      "github_apps",
      "github_installation_links",
      "github_installation_snapshots",
      "github_installation_states",
      "github_packages_settings",
      "github_workflow_dispatches",
      "github_workspace_settings",
      "grants",
      "idempotency_keys",
      "installation_profiles",
      "invites",
      "linked_accounts",
      "login_methods",
      "mcp_servers",
      "member_team_members",
      "member_teams",
      "memberships",
      "neutral_field_progress",
      "outcome_refresh_quotas",
      "owner_workspace_map",
      "password_resets",
      "pending_requests",
      "permission_grants",
      "profile_fill",
      "profile_rollout_items",
      "profile_rollouts",
      "provider_connections",
      "provider_usage",
      "provider_usage_totals",
      "pull_requests",
      "push_continuations",
      "push_follow_ups",
      "push_intents",
      "push_requests",
      "queue_messages",
      "receipts",
      "secret_values",
      "session_achievements",
      "session_commit_attributions",
      "session_event_archives",
      "session_links",
      "session_model_usage",
      "session_outcomes",
      "session_pre_metering_cost",
      "session_repository_attachments",
      "session_share_targets",
      "session_shares",
      "session_title_requests",
      "sessions",
      "settings_generation",
      "slack_apps",
      "slack_config_tokens",
      "slack_inbound_events",
      "slack_install_states",
      "slack_installations",
      "slack_outbox",
      "slack_thread_status",
      "storage_usage",
      "surface_bindings",
      "tool_call_days",
      "tool_call_outcomes",
      "tool_call_progress",
      "tool_calls",
      "tool_descriptions",
      "turn_continuations",
      "turns",
      "unassigned_sessions",
      "users",
      "web_sessions",
      "worker_credentials",
      "worker_image_refusals",
      "worker_launches",
      "workers",
      "workspace_profiles",
      "workspaces",
    ]);
  });

  test("applies defaults to the new session control columns", async () => {
    const { db } = await migratedDatabase();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });

    const [session] = await db
      .select({
        admissionState: sessions.admissionState,
        revision: sessions.revision,
        leaseEpoch: sessions.leaseEpoch,
      })
      .from(sessions);
    expect(session).toEqual({
      admissionState: "active",
      revision: 0,
      leaseEpoch: 0,
    });
  });

  test("enforces idempotency and checkpoint composite primary keys", async () => {
    const { db } = await migratedDatabase();
    const sessionId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: "owner",
      operation: "create_session",
      targetRef: { session_id: sessionId },
    });
    const idempotencyKey = {
      principal: "owner",
      operation: "create_session",
      resource: sessionId,
      key: "request-1",
      payloadHash: "hash",
      receiptId,
    };
    await db.insert(idempotencyKeys).values(idempotencyKey);
    let idempotencyError: unknown;
    try {
      await db.insert(idempotencyKeys).values(idempotencyKey);
    } catch (error) {
      idempotencyError = error;
    }
    expect(idempotencyError).toBeDefined();

    const checkpoint = {
      sessionId,
      revision: 1,
      manifestRef: "s3://bucket/manifest.json",
      manifestSha256: "sha256",
    };
    await db.insert(checkpoints).values(checkpoint);
    let checkpointError: unknown;
    try {
      await db.insert(checkpoints).values(checkpoint);
    } catch (error) {
      checkpointError = error;
    }
    expect(checkpointError).toBeDefined();
  });

  test("dedups worker events per session attempt", async () => {
    const { db } = await migratedDatabase();
    const sessionIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of sessionIds) {
      await db.insert(sessions).values({
        id,
        ownerId: "owner",
        repoUrl: "https://example.invalid/repo.git",
        branch: `session/${id}`,
      });
    }
    const event = (sessionId: string) => ({
      sessionId,
      type: "status",
      payload: { phase: "running" },
      attemptId: "a1",
      sourceSequence: 0,
    });
    await db.insert(events).values(sessionIds.map(event));
    await expect(
      db
        .insert(events)
        .values(event(sessionIds[0] as string))
        .execute(),
    ).rejects.toThrow();
  });

  test("keeps event ids monotonic within a session", async () => {
    const { db } = await migratedDatabase();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });
    const inserted = await db
      .insert(events)
      .values([
        { sessionId, type: "status", payload: { sequence: 1 } },
        { sessionId, type: "status", payload: { sequence: 2 } },
        { sessionId, type: "status", payload: { sequence: 3 } },
      ])
      .returning({ id: events.id });
    expect(inserted.map(({ id }) => id)).toEqual([1, 2, 3]);
  });

  test("stores only a key hash and keeps the partial pod index", async () => {
    const { client } = await migratedDatabase();
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys' ORDER BY column_name",
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      "agent_id",
      "created_at",
      "created_by_user_id",
      "expires_at",
      "id",
      "key_hash",
      "kind",
      "last_used_at",
      "name",
      "owner_id",
      "revoked_at",
      "scopes",
      "workspace_id",
    ]);
    const index = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'sessions_pod_uniq'",
    );
    expect(index.rows[0]?.indexdef).toContain("WHERE (pod_id IS NOT NULL)");
  });
});
