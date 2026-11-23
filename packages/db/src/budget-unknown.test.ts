import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { BudgetChoice } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  createBudgetLedger,
  markBudgetUnknownIn,
  unknownBudgetByAccount,
} from "./budget-accounts.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

const WORKSPACE = "00000000-0000-4000-8000-0000000000d3";

async function held(choice: BudgetChoice, costUsd: number, unknown: boolean) {
  const callId = `call-${crypto.randomUUID()}`;
  await createBudgetLedger(db).reserve({
    callId,
    workspaceId: WORKSPACE,
    choice,
    reserve: { costUsd, tokens: costUsd * 100 },
    unmetered: false,
  });
  if (unknown) {
    await db.transaction((tx) => markBudgetUnknownIn(tx, callId, true));
  }
  return callId;
}

test("the batch lists the accounts holding the most; the total counts every account and only reserved unknown ends", async () => {
  const person = (): BudgetChoice => ({
    rootKind: "user",
    owner: { kind: "user", userId: crypto.randomUUID() },
  });
  const [a, b, c] = [person(), person(), person()];
  await held(a, 3, true);
  await held(a, 1, true);
  await held(b, 2, true);
  await held(c, 1, true);
  // Not counted: reserved and known, settled, released.
  await held(c, 5, false);
  const settled = await held(c, 5, true);
  await createBudgetLedger(db).settle({
    callId: settled,
    actual: { costUsd: 1, tokens: 1 },
  });
  const released = await held(b, 5, true);
  await createBudgetLedger(db).release(released);
  // A key's call of an agent with no team: held on no account.
  await held({ rootKind: "key", owner: null }, 2, true);

  const report = await unknownBudgetByAccount(db, 2);
  expect(report.accounts.map((row) => [row.count, row.costUsd])).toEqual([
    [2, 4],
    [1, 2],
  ]);
  expect(report.total).toEqual({
    accountCount: 4,
    count: 5,
    costUsd: 9,
    tokens: 900,
  });
});
