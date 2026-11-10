import { describe, expect, test } from "bun:test";
import { eventToolResult } from "@werft-ai/contracts";
import { Api, e2eEnv, poll, type SseEvent } from "../e2e/client.ts";
import { scriptId } from "./engine.ts";
import { engineFromEnv } from "./engines.ts";

/**
 * A tool approval is allowed, denied or left to expire, and the engine
 * reports each the same way: one `question` event, one pending permission
 * request, then a settled turn. Verdicts come from the engine-neutral event
 * fields (`question.tool_use_id`, `tool_result.tool_call_id` and `is_error`),
 * never from the command's output or the model's text.
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
  return {
    sessionId,
    requestId: String(request?.request_id),
    toolUseId: String(question?.data.data.tool_use_id),
  };
}

/** The tool result the engine reported for the call the approval was asked for. */
async function resultOf(sessionId: string, toolUseId: string) {
  const events = await api.events(
    sessionId,
    (event) => event.event === "result" && event.data.turn_id === "1",
  );
  const found = events
    .filter((event: SseEvent) => event.event === "tool_result")
    .map((event) => eventToolResult(event.data.data))
    .filter((result) => result?.tool_call_id === toolUseId);
  expect(found).toHaveLength(1);
  return found[0];
}

describe(`tool approval on ${engine.runtimeKind}`, () => {
  test(
    "allow runs the command and completes the turn",
    async () => {
      const { sessionId, requestId, toolUseId } =
        await askForApproval("approve");
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
      expect((await resultOf(sessionId, toolUseId))?.is_error).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "deny keeps the command from running and reports the call as an error",
    async () => {
      const { sessionId, requestId, toolUseId } = await askForApproval("deny");
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
      expect((await resultOf(sessionId, toolUseId))?.is_error).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "an unanswered request expires and can no longer be answered",
    async () => {
      const { sessionId, requestId, toolUseId } =
        await askForApproval("expire");
      // PENDING_REQUEST_TTL_SEC is 90 in tests/conformance/compose.yml.
      await poll(`${requestId} to expire`, 240_000, async () =>
        (await api.pending(sessionId)).length === 0 ? true : null,
      );
      // An expired request is denied: the call ends as an error, as on deny.
      await api.settledTurn(sessionId, "1");
      expect((await resultOf(sessionId, toolUseId))?.is_error).toBe(true);
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
