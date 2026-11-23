import { describe, expect } from "bun:test";
import { Api, e2eStack, poll } from "../e2e/client.ts";
import { docker, serviceContainer } from "./docker.ts";
import { scenario, scriptId } from "./engine.ts";
import { engineFromEnv } from "./engines.ts";

/**
 * A provider call's usage is recorded against the session, and once the
 * session is over its cost limit the next provider call is refused before it
 * reaches the provider. SESSION_COST_LIMIT_USD is 5 on this stack
 * (tests/e2e/run.sh --conformance), and one scripted reply of 5000000 input
 * tokens costs more than that on any metered model.
 */
const LIMIT_USD = 5;
const engine = engineFromEnv();
const api = new Api(
  await e2eStack({ needsMessages: false, connectionId: engine.connectionId }),
);
const TIMEOUT = 600_000;
/** How long the slow session's provider call stays open. */
const HELD_MS = 180_000;

/**
 * How many provider egress authorizations this stack's gateway has refused
 * for the budget. The log line carries no session id, so the scenario counts
 * before and after: the stack is the run's own and no other scenario spends.
 */
async function budgetRefusals(): Promise<number> {
  let count = 0;
  const log = await docker(["logs", await serviceContainer("api")]);
  for (const line of log.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      const entry = JSON.parse(line.slice(start)) as {
        message?: string;
        fields?: { code?: string; purpose?: string };
      };
      if (
        entry.message === "Egress authorization refused" &&
        entry.fields?.purpose === "provider" &&
        entry.fields.code === "BUDGET_EXCEEDED"
      ) {
        count += 1;
      }
    } catch {
      // Not a JSON log line.
    }
  }
  return count;
}

describe(`cost limit on ${engine.runtimeKind}`, () => {
  scenario(
    engine,
    "provider_budget",
    "the call after the one that spent the limit is refused and the session fails",
    async () => {
      const id = scriptId("budget");
      const refusedBefore = await budgetRefusals();
      const created = await api.createSession(
        engine.prompt({
          id,
          commands: ["echo budget"],
          final: "never reached",
          usage: { input_tokens: 5_000_000, output_tokens: 1_000 },
        }),
        undefined,
        engine.repositoryId,
      );
      expect(created.status).toBe(201);
      const sessionId = created.body.session_id;
      const turn = await api.settleAllowing(sessionId, "1");
      expect(turn.status).toBe("failed");

      const session = await api.session(sessionId);
      expect(session.status).toBe("failed");
      expect(session.attention?.code).toBe("BUDGET_EXCEEDED");

      // The first call was metered; the second never reached the provider.
      const usage = await api.usage(sessionId);
      expect(Number(usage.cost.amount_usd)).toBeGreaterThan(LIMIT_USD);
      expect(usage.token_count).toBeGreaterThanOrEqual(5_001_000);
      expect(usage.budget_exceeded).toBe(true);
      const calls = await engine.modelCalls(id);
      expect(calls.map((call) => call.step)).toEqual([0]);

      // The refusal is the gateway's: a session that failed for another
      // reason after its first reply would pass every check above.
      expect(await budgetRefusals()).toBeGreaterThan(refusedBefore);
    },
    TIMEOUT,
  );
});

/** psql in the stack's postgres container, as the container's own user. */
async function sql(query: string): Promise<string[]> {
  const out = await docker([
    "exec",
    await serviceContainer("postgres"),
    "sh",
    "-c",
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -c "$1"',
    "sh",
    query,
  ]);
  return out.split("\n").filter((line) => line.trim() !== "");
}

/** The gateway's own log of opens the budget refused, by the side that did. */
async function accountRefusals(sessionId: string): Promise<number> {
  let count = 0;
  const log = await docker(["logs", await serviceContainer("api")]);
  for (const line of log.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      const entry = JSON.parse(line.slice(start)) as {
        message?: string;
        fields?: { session_id?: string; refused_by?: string };
      };
      if (
        entry.message === "Provider exchange refused for the budget" &&
        entry.fields?.session_id === sessionId &&
        entry.fields.refused_by === "account"
      ) {
        count += 1;
      }
    } catch {
      // Not a JSON log line.
    }
  }
  return count;
}

describe(`budget account on ${engine.runtimeKind}`, () => {
  scenario(
    engine,
    "provider_budget",
    "two calls in flight on one team account: the one past its limit is refused, the other runs and settles",
    async () => {
      // A first session, with no limit, shows what one call holds and on
      // which account: the suite's key has no person, so the agent's team.
      const warm = scriptId("budget-warm");
      const warmed = await api.createSession(
        engine.prompt({ id: warm, commands: [], final: "warm" }),
        undefined,
        engine.repositoryId,
      );
      expect(warmed.status).toBe(201);
      const warmId = warmed.body.session_id;
      expect((await api.settleAllowing(warmId, "1")).status).toBe("completed");
      const [held] = await sql(
        `select r.workspace_id, a.owner_id, r.tokens, r.root_kind from budget_reservations r join budget_accounts a on a.id = r.account_id where a.owner_kind = 'team' and r.call_id in (select exchange_id::text from provider_usage where session_id = '${warmId}') order by r.tokens desc limit 1`,
      );
      expect(held).toBeDefined();
      const [workspaceId, teamId, tokens, rootKind] = (held as string).split(
        "|",
      );
      expect(rootKind).toBe("key");
      const reserve = Number(tokens);
      expect(reserve).toBeGreaterThan(0);
      const [spent] = await sql(
        `select spent_tokens + reserved_tokens from budget_accounts where owner_kind = 'team' and owner_id = '${teamId}' order by period_start desc limit 1`,
      );
      // Room for one more call's reserve and a little: a second call, even
      // one the engine asks again with a smaller reserve, does not fit.
      const limit = Number(spent) + reserve + 1_000;
      await sql(
        `insert into budget_limits (workspace_id, subject, subject_id, tokens) values ('${workspaceId}', 'team', '${teamId}', ${limit})`,
      );
      try {
        const slow = scriptId("budget-slow");
        const first = await api.createSession(
          engine.prompt({
            id: slow,
            commands: [],
            final: "slow",
            // Longer than the second session takes to fail; checked below.
            finalDelayMs: HELD_MS,
          }),
          undefined,
          engine.repositoryId,
        );
        expect(first.status).toBe(201);
        const firstId = first.body.session_id;
        // Its call is open, holding its reserve, while the provider waits.
        await poll("the slow call to be open", 120_000, async () => {
          const rows = await sql(
            `select 1 from provider_exchanges where session_id = '${firstId}' and released_at is null and budget_root_kind = 'key'`,
          );
          return rows.length > 0 ? true : null;
        });
        const late = scriptId("budget-late");
        const second = await api.createSession(
          engine.prompt({ id: late, commands: [], final: "never reached" }),
          undefined,
          engine.repositoryId,
        );
        expect(second.status).toBe(201);
        const secondId = second.body.session_id;
        expect((await api.settleAllowing(secondId, "1")).status).toBe("failed");
        // An account's refusal fails the turn as the provider's error and
        // asks the session for no attention, in this release.
        expect((await api.session(secondId)).attention).toBeNull();
        const [ended] = await sql(
          `select terminal_reason from turns where session_id = '${secondId}' and sequence = 1`,
        );
        // Claude Code names it so; Codex's adapter keeps a reason of its own.
        if (engine.runtimeKind === "claude_agent_sdk")
          expect(ended).toBe("api_error");
        expect(await engine.modelCalls(late)).toEqual([]);
        expect(await accountRefusals(secondId)).toBeGreaterThan(0);
        // The first call was still held when the second was refused: the
        // two were in flight together, as the scenario says.
        const [stillOpen] = await sql(
          `select count(*) from provider_exchanges where session_id = '${firstId}' and released_at is null and budget_root_kind = 'key'`,
        );
        expect(Number(stillOpen)).toBe(1);

        expect(
          (await api.settleAllowing(firstId, "1", HELD_MS + 120_000)).status,
        ).toBe("completed");
        // Settled: nothing of the slow call is held any more.
        const [after] = await sql(
          `select reserved_tokens from budget_accounts where owner_kind = 'team' and owner_id = '${teamId}' order by period_start desc limit 1`,
        );
        expect(Number(after)).toBe(0);
      } finally {
        await sql(
          `delete from budget_limits where subject = 'team' and subject_id = '${teamId}'`,
        );
      }
    },
    TIMEOUT,
  );
});
