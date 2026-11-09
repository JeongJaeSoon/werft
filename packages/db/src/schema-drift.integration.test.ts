import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-folder.ts";
import * as schema from "./schema.ts";
import {
  diffCatalogs,
  type Execute,
  readCatalog,
  schemaStatements,
} from "./schema-drift.ts";

const integrationTest = testDatabaseUrl() ? test : test.skip;

// What the migrations hold that schema.ts cannot declare: Drizzle has no
// syntax for functions or triggers, so these are written by hand in SQL.
// Listed exactly, so a migration that loses, disables or rewrites one fails
// as well; a migration that changes one on purpose updates its line here.
const MIGRATIONS_ONLY = [
  // 0226: a state write marks the session's Slack thread status due at commit.
  "constraint pending_requests.pending_requests_slack_thread_status_insert TRIGGER DEFERRABLE INITIALLY DEFERRED",
  "constraint pending_requests.pending_requests_slack_thread_status_update TRIGGER DEFERRABLE INITIALLY DEFERRED",
  // 0236: a push intent or pull request stage change does the same.
  "constraint push_intents.push_intents_slack_thread_status_insert TRIGGER DEFERRABLE INITIALLY DEFERRED",
  "constraint push_intents.push_intents_slack_thread_status_update TRIGGER DEFERRABLE INITIALLY DEFERRED",
  "constraint push_requests.push_requests_slack_thread_status_insert TRIGGER DEFERRABLE INITIALLY DEFERRED",
  "constraint push_requests.push_requests_slack_thread_status_pr_state TRIGGER DEFERRABLE INITIALLY DEFERRED",
  "constraint push_requests.push_requests_slack_thread_status_update TRIGGER DEFERRABLE INITIALLY DEFERRED",
  "constraint session_links.session_links_slack_thread_status_insert TRIGGER DEFERRABLE INITIALLY DEFERRED",
  "constraint session_links.session_links_slack_thread_status_update TRIGGER DEFERRABLE INITIALLY DEFERRED",
  "constraint sessions.sessions_slack_thread_status_update TRIGGER DEFERRABLE INITIALLY DEFERRED",
  "constraint turns.turns_slack_thread_status_insert TRIGGER DEFERRABLE INITIALLY DEFERRED",
  "constraint turns.turns_slack_thread_status_update TRIGGER DEFERRABLE INITIALLY DEFERRED",
  // 0137, 0139, 0255: agent versions, releases and their audit rows are
  // insert-only; a release takes its first approval and its first spec.
  "function agent_releases_approve_once() trigger language plpgsql volatility=v parallel=u body md5 db737d5f3eaabc9ffd18e671ab6bd4da",
  "function agents_reject_mutation() trigger language plpgsql volatility=v parallel=u body md5 f434237a3126c21bab918af2558fbc88",
  "function authz_decisions_refuse_update() trigger language plpgsql volatility=v parallel=u body md5 f3f5febb7e684f1ec6da6675a5dc196c",
  // 0225: every installation settings write raises the one generation.
  "function bump_settings_generation() trigger language plpgsql volatility=v parallel=u body md5 ac57fd6125a65fb817be211cdd37b454",
  // 0201: counters kept by statement triggers, so /metrics and the usage
  // panel read a few rows instead of aggregating their source tables.
  "function checkpoint_output_objects_add() trigger language plpgsql volatility=v parallel=u set enable_seqscan=off body md5 12b46065dfe5eb5ef1ee314816133e71",
  "function checkpoint_output_objects_clear() trigger language plpgsql volatility=v parallel=u body md5 dbef021522410ff4a0caef67dd9503f0",
  "function checkpoint_output_objects_forget() trigger language plpgsql volatility=v parallel=u body md5 1475242b94f49467838a4e0dcd12700e",
  "function checkpoint_output_objects_recount(affected uuid[]) void language plpgsql volatility=v parallel=u set enable_seqscan=off body md5 7feb5d0e1390b9bd183063c453496e88",
  "function checkpoint_output_objects_release() trigger language plpgsql volatility=v parallel=u set enable_seqscan=off body md5 f9c1384d33099e58aafbf4c3e1895063",
  // 0143: an agent identity's credential name is never an agent's.
  "function credential_bindings_exclusive_target() trigger language plpgsql volatility=v parallel=u body md5 55270e3870adbfee5a5edd2ab0daf6a8",
  // 0249: a session's copied variable values go when it closes, by one write
  // every close path passes through.
  "function env_start_without_values(snapshot jsonb) jsonb language sql volatility=i parallel=u body md5 961af7aed215f5220cdabdca4a5a3e41",
  "function provider_usage_totals_add() trigger language plpgsql volatility=v parallel=u body md5 51a5dbe75562562eb9d0788546a19357",
  "function provider_usage_totals_clear() trigger language plpgsql volatility=v parallel=u body md5 85a0b1f735cb692332ac4baaa297ba69",
  "function provider_usage_totals_recount() trigger language plpgsql volatility=v parallel=u body md5 21f013ae13ff4eeb4ca390ed5296bf34",
  // 0000: the queue's admission count.
  "function queue_unassigned_session_count() double precision language sql volatility=s parallel=u body md5 77ab23e0fa3455549b846ff0e7980c2a",
  // 0172: a system pause's reason is cleared once the session leaves it.
  "function sessions_clear_env_values() trigger language plpgsql volatility=v parallel=u body md5 dc88ade530dc71df6e1156e1525f8a04",
  "function sessions_clear_pause_reason() trigger language plpgsql volatility=v parallel=u body md5 42f7916898b6ee5d3ea948c318a3d61c",
  // 0127, capped by 0129: a session's provider tokens are counted as usage
  // rows are inserted; usage_breakdown_rollup also keeps session_model_usage.
  "function sessions_count_provider_tokens() trigger language plpgsql volatility=v parallel=u body md5 d379ea7e669588977ef342b8f7d882d5",
  "function slack_thread_status_of_row() trigger language plpgsql volatility=v parallel=u body md5 82b785c73c74e41ac9d4ca426506e7d3",
  "function slack_thread_status_of_session() trigger language plpgsql volatility=v parallel=u body md5 2dfe6ae6f5da387e822bf624ebaeb999",
  "function slack_thread_status_touch(session uuid) void language sql volatility=v parallel=u body md5 c4d8bde1fd53798d7cd4a18e5187512f",
  // 0107: retained input is charged to storage_usage as turns are inserted.
  "function storage_usage_charge_turn() trigger language plpgsql volatility=v parallel=u body md5 181d4bb80e87699778f44b2c2d4b738f",
  "function tool_call_outcomes_add() trigger language plpgsql volatility=v parallel=u body md5 658a9e9cf14c49d749ab3d2d896981e9",
  "function tool_call_outcomes_clear() trigger language plpgsql volatility=v parallel=u body md5 4a1a849f5fa78d7ae7af0811e384d367",
  "function tool_call_outcomes_move() trigger language plpgsql volatility=v parallel=u body md5 82bf46a170d219511ff317b80c5fbedc",
  "function tool_call_outcomes_recount() trigger language plpgsql volatility=v parallel=u body md5 6c067f1329647fde76975f2d42ad57b4",
  // 0170: tool_call_days' duration histogram, filled and summed in SQL.
  "function tool_hist(integer, integer) integer[] language internal volatility=i parallel=u body md5 3eb6d2f5e7ee95ed566dd6cdda54dac3",
  "function tool_hist_add(a integer[], b integer[]) integer[] language sql volatility=i parallel=s body md5 06b5f26e393c4c8ceab73150900e0667",
  "function tool_hist_step(state integer[], bucket integer, delta integer) integer[] language sql volatility=i parallel=s body md5 20e7f2741f305c44a7febf7acc1b90ff",
  "function tool_hist_sum(integer[]) integer[] language internal volatility=i parallel=u body md5 3eb6d2f5e7ee95ed566dd6cdda54dac3",
  "function tool_ms_bucket(ms bigint) integer language sql volatility=i parallel=s body md5 6a2f107430551d1a26c5afd7b02f7985",
  "trigger CREATE CONSTRAINT TRIGGER pending_requests_slack_thread_status_insert AFTER INSERT ON public.pending_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER pending_requests_slack_thread_status_update AFTER UPDATE ON public.pending_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.resolved_at IS DISTINCT FROM new.resolved_at) OR (old.answered_at IS DISTINCT FROM new.answered_at) OR (old.parked_at IS DISTINCT FROM new.parked_at) OR (old.expires_at IS DISTINCT FROM new.expires_at))) EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER push_intents_slack_thread_status_insert AFTER INSERT ON public.push_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER push_intents_slack_thread_status_update AFTER UPDATE ON public.push_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER push_requests_slack_thread_status_insert AFTER INSERT ON public.push_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER push_requests_slack_thread_status_pr_state AFTER UPDATE ON public.push_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((old.pr_state IS DISTINCT FROM new.pr_state)) EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER push_requests_slack_thread_status_update AFTER UPDATE ON public.push_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((old.state IS DISTINCT FROM new.state)) EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER session_links_slack_thread_status_insert AFTER INSERT ON public.session_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.session_id IS NOT NULL)) EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER session_links_slack_thread_status_update AFTER UPDATE ON public.session_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.session_id IS NOT NULL) AND ((old.session_id IS DISTINCT FROM new.session_id) OR (old.revoked_at IS DISTINCT FROM new.revoked_at) OR (old.muted IS DISTINCT FROM new.muted)))) EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER sessions_slack_thread_status_update AFTER UPDATE ON public.sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.admission_state IS DISTINCT FROM new.admission_state) OR (old.execution_revoked_at IS DISTINCT FROM new.execution_revoked_at) OR (old.checkpoint_revision IS DISTINCT FROM new.checkpoint_revision))) EXECUTE FUNCTION slack_thread_status_of_session() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER turns_slack_thread_status_insert AFTER INSERT ON public.turns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE CONSTRAINT TRIGGER turns_slack_thread_status_update AFTER UPDATE ON public.turns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION slack_thread_status_of_row() enabled=O",
  "trigger CREATE TRIGGER agent_activation_events_insert_only BEFORE DELETE OR UPDATE ON public.agent_activation_events FOR EACH ROW EXECUTE FUNCTION agents_reject_mutation() enabled=O",
  "trigger CREATE TRIGGER agent_releases_approve_once BEFORE DELETE OR UPDATE ON public.agent_releases FOR EACH ROW EXECUTE FUNCTION agent_releases_approve_once() enabled=O",
  "trigger CREATE TRIGGER agent_versions_insert_only BEFORE DELETE OR UPDATE ON public.agent_versions FOR EACH ROW EXECUTE FUNCTION agents_reject_mutation() enabled=O",
  "trigger CREATE TRIGGER authz_decisions_append_only BEFORE UPDATE ON public.authz_decisions FOR EACH ROW EXECUTE FUNCTION authz_decisions_refuse_update() enabled=O",
  "trigger CREATE TRIGGER catalog_repositories_settings_generation AFTER INSERT OR DELETE OR UPDATE ON public.catalog_repositories FOR EACH ROW EXECUTE FUNCTION bump_settings_generation() enabled=O",
  "trigger CREATE TRIGGER checkpoint_outputs_count_delete AFTER DELETE ON public.checkpoint_outputs REFERENCING OLD TABLE AS removed_rows FOR EACH STATEMENT EXECUTE FUNCTION checkpoint_output_objects_forget() enabled=O",
  "trigger CREATE TRIGGER checkpoint_outputs_count_insert AFTER INSERT ON public.checkpoint_outputs REFERENCING NEW TABLE AS added_rows FOR EACH STATEMENT EXECUTE FUNCTION checkpoint_output_objects_add() enabled=O",
  "trigger CREATE TRIGGER checkpoint_outputs_count_truncate AFTER TRUNCATE ON public.checkpoint_outputs FOR EACH STATEMENT EXECUTE FUNCTION checkpoint_output_objects_clear() enabled=O",
  "trigger CREATE TRIGGER checkpoints_count_release AFTER UPDATE ON public.checkpoints REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION checkpoint_output_objects_release() enabled=O",
  "trigger CREATE TRIGGER credential_bindings_exclusive_target BEFORE INSERT OR UPDATE ON public.credential_bindings FOR EACH ROW EXECUTE FUNCTION credential_bindings_exclusive_target() enabled=O",
  "trigger CREATE TRIGGER installation_profiles_settings_generation AFTER INSERT OR DELETE OR UPDATE ON public.installation_profiles FOR EACH ROW EXECUTE FUNCTION bump_settings_generation() enabled=O",
  "trigger CREATE TRIGGER mcp_servers_settings_generation AFTER INSERT OR DELETE OR UPDATE ON public.mcp_servers FOR EACH ROW EXECUTE FUNCTION bump_settings_generation() enabled=O",
  "trigger CREATE TRIGGER provider_connections_settings_generation AFTER INSERT OR DELETE OR UPDATE ON public.provider_connections FOR EACH ROW EXECUTE FUNCTION bump_settings_generation() enabled=O",
  "trigger CREATE TRIGGER provider_usage_count_delete AFTER DELETE ON public.provider_usage REFERENCING OLD TABLE AS removed_rows FOR EACH STATEMENT EXECUTE FUNCTION provider_usage_totals_recount() enabled=O",
  "trigger CREATE TRIGGER provider_usage_count_insert AFTER INSERT ON public.provider_usage REFERENCING NEW TABLE AS added_rows FOR EACH STATEMENT EXECUTE FUNCTION provider_usage_totals_add() enabled=O",
  "trigger CREATE TRIGGER provider_usage_count_tokens AFTER INSERT ON public.provider_usage FOR EACH ROW EXECUTE FUNCTION sessions_count_provider_tokens() enabled=O",
  "trigger CREATE TRIGGER provider_usage_count_truncate AFTER TRUNCATE ON public.provider_usage FOR EACH STATEMENT EXECUTE FUNCTION provider_usage_totals_clear() enabled=O",
  "trigger CREATE TRIGGER sessions_clear_env_values_trg BEFORE UPDATE OF admission_state ON public.sessions FOR EACH ROW WHEN (((new.admission_state = 'closed'::admission_state) AND (old.admission_state IS DISTINCT FROM 'closed'::admission_state) AND (new.env_start IS NOT NULL))) EXECUTE FUNCTION sessions_clear_env_values() enabled=O",
  "trigger CREATE TRIGGER sessions_clear_pause_reason BEFORE UPDATE ON public.sessions FOR EACH ROW WHEN (((new.pause_reason IS NOT NULL) AND (new.admission_state <> ALL (ARRAY['pausing'::admission_state, 'paused'::admission_state])))) EXECUTE FUNCTION sessions_clear_pause_reason() enabled=O",
  "trigger CREATE TRIGGER tool_calls_count_delete AFTER DELETE ON public.tool_calls REFERENCING OLD TABLE AS removed_rows FOR EACH STATEMENT EXECUTE FUNCTION tool_call_outcomes_recount() enabled=O",
  "trigger CREATE TRIGGER tool_calls_count_insert AFTER INSERT ON public.tool_calls REFERENCING NEW TABLE AS added_rows FOR EACH STATEMENT EXECUTE FUNCTION tool_call_outcomes_add() enabled=O",
  "trigger CREATE TRIGGER tool_calls_count_truncate AFTER TRUNCATE ON public.tool_calls FOR EACH STATEMENT EXECUTE FUNCTION tool_call_outcomes_clear() enabled=O",
  "trigger CREATE TRIGGER tool_calls_count_update AFTER UPDATE ON public.tool_calls REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION tool_call_outcomes_move() enabled=O",
  "trigger CREATE TRIGGER turns_charge_storage AFTER INSERT ON public.turns FOR EACH ROW EXECUTE FUNCTION storage_usage_charge_turn() enabled=O",
];

const databases: TempDatabase[] = [];
const pools: Pool[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  await Promise.all(databases.splice(0).map((database) => database.drop()));
  for (const folder of folders.splice(0)) {
    rmSync(folder, { force: true, recursive: true });
  }
});

async function database(options: { migrate: boolean }) {
  const created = await createTempDatabase({
    migrate: options.migrate,
    prefix: "schema_drift",
  });
  databases.push(created);
  const pool = new Pool({ connectionString: created.url, max: 1 });
  pools.push(pool);
  const execute: Execute = async (sql) => (await pool.query(sql)).rows;
  return { execute, pool };
}

async function schemaCatalog(): Promise<string[]> {
  const { execute } = await database({ migrate: false });
  for (const statement of await schemaStatements(schema)) {
    await execute(statement);
  }
  return readCatalog(execute);
}

integrationTest(
  "the migrated schema is the schema schema.ts declares",
  async () => {
    const migrated = await database({ migrate: true });
    expect(
      diffCatalogs(await readCatalog(migrated.execute), await schemaCatalog()),
    ).toEqual({ migrationsOnly: MIGRATIONS_ONLY, schemaOnly: [] });
  },
  60_000,
);

integrationTest(
  "a CHECK missing from a migration's SQL is caught",
  async () => {
    // The snapshot still has the constraint, so the folder check passes, and
    // the migration applies without it.
    const folder = mkdtempSync(join(tmpdir(), "migrations-"));
    folders.push(folder);
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const file = join(folder, "0111_next_havok.sql");
    const original = readFileSync(file, "utf8");
    const edited = original
      .split("\n")
      .filter((line) => !line.includes("worker_launches_launch_attempts_check"))
      .join("\n");
    expect(edited).not.toBe(original);
    writeFileSync(file, edited);

    const migrated = await database({ migrate: false });
    await migrate(drizzle(migrated.pool), { migrationsFolder: folder });

    expect(
      diffCatalogs(await readCatalog(migrated.execute), await schemaCatalog()),
    ).toEqual({
      migrationsOnly: MIGRATIONS_ONLY,
      schemaOnly: [
        "constraint worker_launches.worker_launches_launch_attempts_check CHECK ((launch_attempts >= 0))",
      ],
    });
  },
  60_000,
);
