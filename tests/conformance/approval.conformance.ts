import { describe, expect, test } from "bun:test";
import { Api, e2eEnv, poll } from "../e2e/client.ts";
import { scriptId } from "./engine.ts";
import { engineFromEnv } from "./engines.ts";

/**
 * A tool approval is allowed, denied or left to expire, and the engine
 * reports each the same way: one `question` event, one pending permission
 * request, then a settled turn. The turn's text is never read.
 */
const engine = engineFromEnv();
const api = new Api(e2eEnv({ needsMessages: false }));
const TIMEOUT = 600_000;

/** A session whose first turn runs the engine's approval-requiring command. */
async function askForApproval(name: string) {
  const created = await api.createSession(
    engine.prompt({
      id: scriptId(name),
      commands: [engine.approvalCommand],
      final: "after the command",
    }),
    undefined,
    engine.profileId,
    engine.repositoryId,
  );
  expect(created.status).toBe(201);
  const sessionId = created.body.session_id;
  const events = await api.events(
    sessionId,
    (event) => event.event === "question",
  );
  const question = events.at(-1);
  expect(question?.data.turn_id).toBe("1");
  const [request] = await api.pendingUntil(sessionId, 1);
  expect(request).toMatchObject({
    kind: "permission",
    turn_id: "1",
    request_id: question?.data.data.request_id,
  });
  expect(typeof request?.tool).toBe("string");
  expect((await api.session(sessionId)).status).toBe("needs_input");
  return { sessionId, requestId: String(request?.request_id) };
}

describe(`tool approval on ${engine.runtimeKind}`, () => {
  test(
    "allow runs the command and completes the turn",
    async () => {
      const { sessionId, requestId } = await askForApproval("approve");
      const answer = await api.allow(sessionId, requestId);
      expect((await api.settledTurn(sessionId, "1")).status).toBe("completed");
      expect(
        (
          await api.receiptUntil(
            answer.receipt_id,
            (receipt) => receipt.status !== "accepted",
          )
        ).status,
      ).toBe("succeeded");
      expect(await api.pending(sessionId)).toEqual([]);
      const events = await api.events(
        sessionId,
        (event) => event.event === "tool_result" && event.data.turn_id === "1",
      );
      expect(events.at(-1)?.event).toBe("tool_result");
    },
    TIMEOUT,
  );

  test(
    "deny keeps the command from running and settles the turn",
    async () => {
      const { sessionId, requestId } = await askForApproval("deny");
      const answer = await api.deny(sessionId, requestId);
      expect(
        (
          await api.receiptUntil(
            answer.receipt_id,
            (receipt) => receipt.status !== "accepted",
          )
        ).status,
      ).toBe("succeeded");
      const turn = await api.settledTurn(sessionId, "1");
      expect(["completed", "failed", "interrupted"]).toContain(turn.status);
      expect(await api.pending(sessionId)).toEqual([]);
      // The command's own output ("conformance") never reached a tool result.
      const events = await api.events(
        sessionId,
        (event) => event.event === "result" && event.data.turn_id === "1",
      );
      const results = events.filter((event) => event.event === "tool_result");
      expect(
        JSON.stringify(results.map((event) => event.data.data)),
      ).not.toContain("conformance");
    },
    TIMEOUT,
  );

  test(
    "an unanswered request expires and can no longer be answered",
    async () => {
      const { sessionId, requestId } = await askForApproval("expire");
      // PENDING_REQUEST_TTL_SEC is 90 in tests/conformance/compose.yml.
      await poll(`${requestId} to expire`, 240_000, async () =>
        (await api.pending(sessionId)).length === 0 ? true : null,
      );
      const late = await api.request(
        "POST",
        `/v1/sessions/${sessionId}/answers`,
        { request_id: requestId, kind: "permission", action: "allow" },
      );
      expect(late.status).toBeGreaterThanOrEqual(400);
      expect(late.status).toBeLessThan(500);
    },
    TIMEOUT,
  );
});
