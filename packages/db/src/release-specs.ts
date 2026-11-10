import type {
  ReleaseSpecRecord,
  SpecBackfillStore,
  SpecRelease,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import { assertReleasesWritable } from "./profile-freeze.ts";
import type { Database } from "./queries.ts";

type PendingRow = {
  id: string;
  agent_id: string;
  card_sha256: string;
  runtime_profile_id: string;
  repository_id: string | null;
  profile_digest: string;
  runtime_config_snapshot: SpecRelease["runtime_config_snapshot"];
  effective_tools: SpecRelease["effective_tools"];
  policy_pins: SpecRelease["policy_pins"];
};

/**
 * The release rows the spec backfill reads and writes. The four spec columns
 * are one unit (`agent_releases_spec_check`), so they are written in one
 * statement, and only over a row that has none.
 */
export function releaseSpecStore(db: Database): SpecBackfillStore {
  return {
    async pending(after, limit) {
      const rows = rowsOf<PendingRow>(
        await db.execute(sql`
          SELECT id, agent_id, card_sha256, runtime_profile_id, repository_id,
                 profile_digest, runtime_config_snapshot, effective_tools, policy_pins
          FROM agent_releases
          WHERE runtime_spec IS NULL
            AND (${after}::text IS NULL OR id > ${after})
          ORDER BY id
          LIMIT ${limit}
        `),
      );
      return rows.map(
        (row): SpecRelease => ({
          id: row.id,
          agent_id: row.agent_id,
          card_sha256: row.card_sha256,
          runtime_profile_id: row.runtime_profile_id,
          repository_id: row.repository_id,
          profile_digest: row.profile_digest,
          runtime_config_snapshot: row.runtime_config_snapshot,
          effective_tools: row.effective_tools,
          policy_pins: row.policy_pins,
        }),
      );
    },

    // A transaction of its own, for the freeze barrier: while releases are
    // frozen this throws, and the backfill pass retries when it is lifted.
    async save(releaseId: string, record: ReleaseSpecRecord) {
      return db.transaction(async (tx) => {
        await assertReleasesWritable(tx);
        const updated = rowsOf<{ id: string }>(
          await tx.execute(sql`
            UPDATE agent_releases
            SET runtime_spec = ${JSON.stringify(record.runtime_spec)}::jsonb,
                spec_source = ${JSON.stringify(record.spec_source)}::jsonb,
                spec_source_digest = ${record.spec_source_digest},
                spec_digest = ${record.spec_digest}
            WHERE id = ${releaseId} AND runtime_spec IS NULL
            RETURNING id
          `),
        );
        return updated.length === 1;
      });
    },
  };
}
