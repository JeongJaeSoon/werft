import { describe, expect } from "bun:test";
import { Api, e2eEnv } from "../e2e/client.ts";
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
const api = new Api(e2eEnv({ needsMessages: false }));
const TIMEOUT = 600_000;

describe(`cost limit on ${engine.runtimeKind}`, () => {
  scenario(
    engine,
    "provider_budget",
    "the call after the one that spent the limit is refused and the session fails",
    async () => {
      const id = scriptId("budget");
      const created = await api.createSession(
        engine.prompt({
          id,
          commands: ["echo budget"],
          final: "never reached",
          usage: { input_tokens: 100_000, output_tokens: 1_000 },
        }),
        undefined,
        engine.profileId,
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
    },
    TIMEOUT,
  );
});
