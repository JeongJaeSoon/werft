import { describe, expect, test } from "bun:test";
import { Api, e2eEnv } from "../e2e/client.ts";
import { modelCallSeen, scriptId } from "./engine.ts";
import { engineFromEnv } from "./engines.ts";

/**
 * Session create → message → events (live and replayed) → interrupt →
 * terminate, the same steps whatever the engine. Verdicts come from event
 * kinds, session and turn statuses and receipts, never from the model's text.
 */
const engine = engineFromEnv();
const api = new Api(e2eEnv({ needsMessages: false }));
const TIMEOUT = 600_000;

/** An event id is `ev_` and the stored row's id in base 36. */
function position(id: string | undefined): number {
  expect(id).toMatch(/^ev_[0-9a-z]{1,11}$/);
  const value = Number.parseInt(String(id).slice(3), 36);
  expect(Number.isSafeInteger(value)).toBe(true);
  return value;
}

describe(`session lifecycle on ${engine.runtimeKind}`, () => {
  test(
    "create, message, replay the events, interrupt, terminate",
    async () => {
      // 1. create: the first turn runs to completion.
      const first = scriptId("life-1");
      const created = await api.createSession(
        engine.prompt({ id: first, commands: [], final: "one" }),
        undefined,
        engine.profileId,
        engine.repositoryId,
      );
      expect(created.status).toBe(201);
      const sessionId = created.body.session_id;
      expect(created.body).toMatchObject({ turn_id: "1", status: "queued" });
      expect((await api.settledTurn(sessionId, "1")).status).toBe("completed");

      // 2. events: the turn's result is on the stream, in id order.
      const events = await api.events(
        sessionId,
        (event) => event.event === "result" && event.data.turn_id === "1",
      );
      expect(events.map((event) => event.event)).toContain("result");
      const ids = events.map((event) => position(event.id));
      for (const [at, id] of ids.entries()) {
        if (at > 0) expect(id).toBeGreaterThan(ids[at - 1] ?? Infinity);
      }

      // 3. replay: reconnecting with Last-Event-ID resumes strictly after it.
      const cut = Math.floor(events.length / 2);
      const cursor = events[cut - 1];
      const lastId = events.at(-1)?.id;
      expect(cursor).toBeDefined();
      const replayed = await api.events(
        sessionId,
        (event) => event.id === lastId,
        180_000,
        cursor?.id,
      );
      expect(replayed.map((event) => event.id)).toEqual(
        events.slice(cut).map((event) => event.id),
      );

      // 4. message: a second turn on the same session, whose events a stream
      // opened after the first turn's last one delivers.
      let opened = () => {};
      const connected = new Promise<void>((resolve) => {
        opened = resolve;
      });
      const tail = api.events(
        sessionId,
        (event) => event.event === "result" && event.data.turn_id === "2",
        180_000,
        lastId,
        opened,
      );
      // The message goes out only once the stream is open, so turn 2's
      // events can reach it only live.
      await Promise.race([connected, tail]);
      const second = await api.send(
        sessionId,
        engine.prompt({ id: scriptId("life-2"), commands: [], final: "two" }),
      );
      expect(second.turn_id).toBe("2");
      expect((await api.settledTurn(sessionId, "2")).status).toBe("completed");
      const delivered = await tail;
      expect(position(delivered[0]?.id)).toBeGreaterThan(position(lastId));

      // 5. interrupt: a turn held in a slow model call stops on request.
      const slowId = scriptId("life-slow");
      const slow = await api.send(
        sessionId,
        engine.prompt({
          id: slowId,
          commands: [],
          final: "late",
          finalDelayMs: 300_000,
        }),
      );
      await api.sessionUntil(
        sessionId,
        "runs the slow turn",
        (s) => s.current_turn_id === slow.turn_id && s.status === "running",
      );
      await modelCallSeen(engine, slowId, 0);
      const interrupt = await api.control(sessionId, "interrupt", {
        target_turn_id: slow.turn_id,
      });
      expect(interrupt.status).toBe(202);
      const interrupted = await api.receiptUntil(
        (interrupt.body as { receipt_id: string }).receipt_id,
        (receipt) => receipt.status !== "accepted",
      );
      expect(interrupted.status).toBe("succeeded");
      expect((await api.settledTurn(sessionId, slow.turn_id)).status).toBe(
        "interrupted",
      );

      // 6. terminate: a turn in flight ends unknown and the session waits
      // for a recovery decision.
      const doomedId = scriptId("life-doomed");
      const doomed = await api.send(
        sessionId,
        engine.prompt({
          id: doomedId,
          commands: [],
          final: "never",
          finalDelayMs: 300_000,
        }),
      );
      await api.sessionUntil(
        sessionId,
        "runs the doomed turn",
        (s) => s.current_turn_id === doomed.turn_id && s.status === "running",
      );
      await modelCallSeen(engine, doomedId, 0);
      const terminate = await api.control(sessionId, "terminate", {
        expected_revision: (await api.session(sessionId)).revision,
        reason: "conformance",
      });
      expect(terminate.status).toBe(202);
      const ended = await api.sessionUntil(
        sessionId,
        "needs a recovery decision",
        (s) => s.admission_state === "recovery_required",
      );
      expect(ended.status).toBe("failed");
      expect((await api.turn(sessionId, doomed.turn_id)).status).toBe(
        "outcome_unknown",
      );
    },
    TIMEOUT,
  );
});
