import { expect, test } from "bun:test";
import {
  apiError,
  json,
  runSample,
  type Seen,
} from "../../testing/sample-server.ts";

const SAMPLE = `${import.meta.dir}/control.ts`;
const SESSION = "fake-session";

/** Just enough of the session state machine for interrupt, pause and recovery. */
function fakeControl(options: { lastTurn: string }) {
  const turns: { status: string; script: string }[] = [];
  const receipts = new Map<string, unknown>();
  let revision = 0;
  let admission = "active";
  let status = "idle";

  const receipt = (operation: string, result: unknown = {}, code = 202) => {
    const id = `receipt-${receipts.size + 1}`;
    receipts.set(id, { id, status: "succeeded", operation, result });
    return json({ receipt_id: id, receipt_status: "accepted" }, code);
  };
  const addTurn = (message: string) => {
    const script = message.match(/"id":"(\w+)"/)?.[1] ?? "";
    const next =
      script === "ctl2" || script === "ctl3" || script === "ctl6"
        ? "running"
        : script === "ctl4"
          ? "queued"
          : script === "ctl7"
            ? options.lastTurn
            : "completed";
    turns.push({ status: next, script });
    return String(turns.length);
  };
  const turnOf = (script: string) => turns.find((t) => t.script === script);
  const checkRevision = (body: unknown) =>
    (body as { expected_revision: number }).expected_revision === revision;

  const route = ({ method, path, body }: Seen) => {
    const action = path.split("/").at(-1);
    if (method === "POST" && path === "/v1/sessions") {
      addTurn((body as { message: string }).message);
      return json({ session_id: SESSION, turn_id: "1", status: "queued" }, 201);
    }
    if (method === "POST" && action === "messages") {
      if (admission === "paused") return apiError(409, "SESSION_PAUSED");
      return json(
        {
          turn_id: addTurn((body as { message: string }).message),
          status: "queued",
        },
        202,
      );
    }
    if (method === "POST" && action !== "interrupt" && !checkRevision(body))
      return apiError(409, "REVISION_CONFLICT");
    if (method === "POST") revision++;
    switch (method === "POST" ? action : "") {
      case "interrupt": {
        const turn =
          turns[
            Number((body as { target_turn_id: string }).target_turn_id) - 1
          ];
        if (turn) turn.status = "interrupted";
        return receipt("interrupt");
      }
      case "pause": {
        const draining = turnOf("ctl3");
        if (draining) draining.status = "completed";
        admission = "paused";
        return receipt("pause");
      }
      case "resume": {
        const queued = turnOf("ctl4");
        if (queued) queued.status = "completed";
        admission = "active";
        status = "idle";
        return receipt("resume");
      }
      case "terminate": {
        const doomed = turnOf("ctl6");
        if (doomed) doomed.status = "outcome_unknown";
        admission = "recovery_required";
        status = "failed";
        const id = `receipt-${receipts.size + 1}`;
        receipts.set(id, {
          id,
          status: "succeeded",
          operation: "terminate",
          result: {},
        });
        return json(
          {
            receipt_id: id,
            receipt_status: "accepted",
            external_effects_reverted: false,
          },
          202,
        );
      }
      case "recovery-decisions": {
        const doomed = turnOf("ctl6");
        if (doomed) doomed.status = "cancelled";
        admission = "stopped";
        status = "stopped";
        return receipt("recovery_decision", { resumable: true });
      }
      case "close":
        return receipt("close");
    }
    if (path.startsWith("/v1/receipts/"))
      return json(receipts.get(action ?? ""));
    const turn = path.match(/\/turns\/(\d+)$/)?.[1];
    if (turn) {
      const t = turns[Number(turn) - 1];
      if (!t) return apiError(404, "NOT_FOUND");
      const ended = !["running", "queued"].includes(t.status);
      return json({
        turn_id: turn,
        status: t.status,
        ended_at: ended ? "2026-10-29T00:00:00Z" : null,
        attempts: [{}],
      });
    }
    if (path === `/v1/sessions/${SESSION}`)
      return json({ revision, admission_state: admission, status });
    return apiError(404, "NOT_FOUND");
  };
  return route;
}

test("interrupts, pauses and recovers one session", async () => {
  const { exit, stdout, stderr, seen } = await runSample(
    SAMPLE,
    fakeControl({ lastTurn: "completed" }),
  );
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  for (const line of [
    "interrupt: turn 2 interrupted",
    "pause with a wrong revision: 409 REVISION_CONFLICT",
    "pause: admission paused, turn 3 completed, turn 4 queued",
    "wait on turn 4: TURN_BLOCKED (paused)",
    "message while paused: 409 SESSION_PAUSED",
    "resume: turn 4 completed",
    "terminate: receipt accepted, external effects reverted false",
    "session: failed/recovery_required, turn 5 outcome_unknown",
    "recovery: abandon, turn 5 cancelled, resumable true",
    "after recovery: turn 6 completed",
    "close: receipt succeeded",
  ])
    expect(stdout).toContain(line);
  const decision = seen.find((r) => r.path.endsWith("/recovery-decisions"));
  expect(decision?.body).toMatchObject({
    decision: "abandon",
    target_turn_id: "5",
  });
}, 30_000);

test("fails when the session does not recover", async () => {
  const { exit, stderr } = await runSample(
    SAMPLE,
    fakeControl({ lastTurn: "failed" }),
  );
  expect(exit).toBe(1);
  expect(stderr).toContain("the session did not recover");
}, 30_000);
