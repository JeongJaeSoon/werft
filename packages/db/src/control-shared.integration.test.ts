import { afterAll, describe, expect, test } from "bun:test";
import {
  budgetExceeded,
  type SessionBudget,
  type SessionSpend,
} from "@werft-ai/platform";
import { testDatabaseUrl } from "@werft-ai/testkit/postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { withinBudget } from "./control-shared.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("withinBudget, the SQL form of budgetExceeded", () => {
  const pool = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
  const db = drizzle(pool);
  afterAll(() => pool.end());

  const budgets: SessionBudget[] = [
    { costUsd: 5, tokens: null },
    { costUsd: 5, tokens: 1_000 },
  ];
  const spends: SessionSpend[] = [4.999999, 5, 5.000001].flatMap((costUsd) =>
    [999, 1_000, 1_001].map((providerTokens) => ({ costUsd, providerTokens })),
  );

  test("admits exactly the spends budgetExceeded leaves under", async () => {
    for (const budget of budgets) {
      for (const spend of spends) {
        // A one-row stand-in with the columns withinBudget reads.
        const [row] = (
          await db.execute<{ within: boolean }>(sql`
            SELECT ${withinBudget(budget)} AS within
            FROM (VALUES (${spend.costUsd}::numeric(14, 6), ${spend.providerTokens}::bigint))
              AS sessions (cost_usd, provider_tokens)`)
        ).rows;
        expect({ budget, spend, within: row?.within }).toEqual({
          budget,
          spend,
          within: !budgetExceeded(spend, budget),
        });
      }
    }
  });
});
