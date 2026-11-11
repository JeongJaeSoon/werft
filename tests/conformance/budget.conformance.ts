import { describe, expect } from "bun:test";
import { Api, e2eStack } from "../e2e/client.ts";
import { docker, serviceContainer } from "./docker.ts";
import { scenario, scriptId } from "./engine.ts";
import { engineFromEnv } from "./engines.ts";

/**
 * A provider call's usage is recorded against the session, and once the
 * session is over its cost limit the next provider call is refused before it
 * reaches the provider. SESSION_COST_LIMIT_USD is 0.25 on this stack
 * (tests/e2e/run.sh --conformance), and one scripted reply of 100000 input
 * tokens costs more than that on any metered model.
 */
const engine = engineFromEnv();
const api = new Api(
  await e2eStack({ needsMessages: false, connectionId: engine.connectionId }),
);
const TIMEOUT = 600_000;

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
          usage: { input_tokens: 100_000, output_tokens: 1_000 },
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
      expect(Number(usage.cost.amount_usd)).toBeGreaterThan(0.25);
      expect(usage.token_count).toBeGreaterThanOrEqual(101_000);
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
