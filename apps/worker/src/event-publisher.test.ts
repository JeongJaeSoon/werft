import { describe, expect, test } from "bun:test";
import type {
  AppendEventsRequest,
  AppendEventsResponse,
  SessionEvent,
  ToolDecisionReport,
  WorkerScope,
} from "@werft-ai/contracts";
import { WorkerGatewayRequestError } from "@werft-ai/runtime-core";

import { EventPublisher } from "./event-publisher.ts";

const scope: WorkerScope = {
  session_id: "11111111-1111-4111-8111-111111111111",
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};

function systemEvent(id: string): SessionEvent {
  return { id, event: "system", data: { type: "system", subtype: id } };
}

function publisher(
  appendEvents: (request: AppendEventsRequest) => Promise<AppendEventsResponse>,
  turnId: string | null = "1",
) {
  const batches: AppendEventsRequest[] = [];
  const instance = new EventPublisher({
    gateway: {
      appendEvents: (request) => {
        batches.push(request);
        return appendEvents(request);
      },
    },
    scope: () => ({ ...scope, turn_id: turnId }),
    retryDelayMs: 1,
  });
  return { batches, publisher: instance };
}

function accepted(request: AppendEventsRequest): AppendEventsResponse {
  const last = request.events.at(-1)?.source_sequence ?? 0;
  return { accepted_through: last, cursor: `cursor-${last}` };
}

/** Publishes the event carrying a call, then names the call, as the pump does. */
function publishCall(events: EventPublisher, toolCallId: string): void {
  events.publish([systemEvent(`call:${toolCallId}`)], "1");
  events.toolCalled(toolCallId);
}

const carriesCall = (request: AppendEventsRequest) =>
  request.events.some(
    (event) =>
      event.event === "system" &&
      String(event.data.subtype).startsWith("call:"),
  );

describe("EventPublisher", () => {
  test("lets a permission callback wait until the frame carrying its tool call is stored", async () => {
    let release: (() => void) | undefined;
    const { publisher: events } = publisher(async (request) => {
      if (carriesCall(request)) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return accepted(request);
    });
    let stored = false;
    const waiting = events.toolUseStored("toolu_1", 5_000).then(() => {
      stored = true;
    });
    events.publish([systemEvent("a")], "1");
    publishCall(events, "toolu_other");
    await Bun.sleep(5);
    expect(stored).toBe(false);
    release?.();
    publishCall(events, "toolu_1");
    // Numbered is not enough: it has to be stored.
    await Bun.sleep(5);
    expect(stored).toBe(false);
    release?.();
    await waiting;
    expect(stored).toBe(true);
  });

  test("a tool call answers one wait, and a wait that runs out or a failed stream rejects", async () => {
    const { publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    publishCall(events, "toolu_1");
    await events.toolUseStored("toolu_1", 5_000);
    // The engine used the id again: this wait is for a frame not seen yet.
    await expect(events.toolUseStored("toolu_1", 30)).rejects.toThrow(
      "did not reach the event stream within 30ms",
    );

    const failing = publisher(async () => {
      throw new WorkerGatewayRequestError(409, "STALE_EPOCH", "fenced", false);
    }).publisher;
    const waiting = failing.toolUseStored("toolu_2", 5_000);
    publishCall(failing, "toolu_2");
    await expect(waiting).rejects.toThrow("fenced");
    // A call stored before the stream failed does not let a request through.
    publishCall(events, "toolu_3");
    await events.idle();
    events.abandon("owner lost");
    await expect(events.toolUseStored("toolu_3", 5_000)).rejects.toThrow(
      "abandoned",
    );
  });

  test("waits for the call to be named, not for an event that looks like one", async () => {
    const { publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    events.publish(
      [
        {
          id: "toolu_1",
          event: "tool_use",
          data: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }],
            },
            parent_tool_use_id: null,
          },
        },
      ],
      "1",
    );

    await expect(events.toolUseStored("toolu_1", 30)).rejects.toThrow(
      "did not reach the event stream within 30ms",
    );
    events.toolCalled("toolu_1");
    await events.toolUseStored("toolu_1", 5_000);
  });

  test("counts a wait from when the engine asked, not from when the host began waiting", async () => {
    const { publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    const started = performance.now();

    await expect(
      events.toolUseStored("toolu_late", 1_000, performance.now() - 990),
    ).rejects.toThrow("did not reach the event stream within 1000ms");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("numbers the attempt's stream from one and keeps frame order", async () => {
    const { batches, publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    events.publish([systemEvent("a"), systemEvent("b")], "1");
    events.publish([systemEvent("c")], "1");
    await events.idle();

    expect(
      batches.flatMap((batch) =>
        batch.events.map((event) => event.source_sequence),
      ),
    ).toEqual([1, 2, 3]);
    expect(events.acceptedThrough).toBe(3);
  });

  test("never mixes two turns into one batch", async () => {
    const { batches, publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    // Both are queued before the first append resolves, so a publisher that
    // batched by size alone would put them in one request.
    events.publish([systemEvent("a")], "1");
    events.publish([systemEvent("b")], "2");
    await events.idle();

    expect(batches.map((batch) => batch.turn_id)).toEqual(["1", "2"]);
  });

  test("replays the same batch key after a retryable failure", async () => {
    let attempts = 0;
    const { batches, publisher: events } = publisher(async (request) => {
      attempts += 1;
      if (attempts === 1) {
        throw new WorkerGatewayRequestError(503, null, "gateway down", true);
      }
      return accepted(request);
    });
    events.publish([systemEvent("a")], "1");
    await events.idle();

    expect(attempts).toBe(2);
    expect(batches[0]?.batch_key).toBe(batches[1]?.batch_key);
    expect(batches[1]?.events[0]?.source_sequence).toBe(1);
  });

  test("stops retrying a batch once its retry budget is spent, and fails the stream", async () => {
    const failed: unknown[] = [];
    let attempts = 0;
    const events = new EventPublisher({
      gateway: {
        appendEvents: async () => {
          attempts += 1;
          throw new WorkerGatewayRequestError(503, null, "gateway down", true);
        },
      },
      scope: () => ({ ...scope, turn_id: "1" }),
      retryDelayMs: 5,
      retryBudgetMs: 50,
      onFailed: (error) => failed.push(error),
    });
    events.publish([systemEvent("a")], "1");

    await expect(events.idle()).rejects.toThrow("gateway down");
    expect(attempts).toBeGreaterThan(1);
    expect(failed).toHaveLength(1);
  });

  test("surfaces a fenced-out write to whoever waits for the tail", async () => {
    const { publisher: events } = publisher(async () => {
      throw new WorkerGatewayRequestError(
        409,
        "LEASE_EXPIRED",
        "lease expired",
        false,
      );
    });
    events.publish([systemEvent("a")], "1");

    await expect(events.idle()).rejects.toThrow("lease expired");
  });

  test("drops the undelivered tail once the attempt is abandoned", async () => {
    const { batches, publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    events.abandon("ownership lost");
    events.publish([systemEvent("a")], "1");

    expect(batches).toEqual([]);
    await expect(events.idle()).rejects.toThrow("ownership lost");
  });

  test("holds back what was published past a cut until it is released", async () => {
    const { batches, publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    events.publish([systemEvent("a"), systemEvent("b")], "1");
    expect(events.hold()).toBe(2);
    events.publish([systemEvent("late")], null);
    await events.idle();

    // Idle means durable up to the cut; the late event is still waiting.
    expect(events.acceptedThrough).toBe(2);
    expect(batches.flatMap((batch) => batch.events)).toHaveLength(2);
    // A second hold does not move the cut.
    expect(events.hold()).toBe(2);

    events.release();
    await events.idle();
    expect(events.acceptedThrough).toBe(3);
    expect(batches.at(-1)?.turn_id).toBeNull();
  });

  describe("tool decisions", () => {
    const report = (id: string): ToolDecisionReport => ({
      call_key: `t:${id}`,
      tool_name: "Bash",
      tool_use_id: id,
      decision: "allow",
      basis: "permission_mode",
    });

    test("ride in the append of their own turn and not another's", async () => {
      const { batches, publisher: events } = publisher(async (request) =>
        accepted(request),
      );
      events.audit(report("a"), "1");
      events.audit(report("b"), "2");
      events.publish([systemEvent("x")], "1");
      await events.idle();
      expect(batches).toHaveLength(1);
      expect(batches[0]?.tool_decisions).toEqual([report("a")]);

      events.publish([systemEvent("y")], "2");
      await events.idle();
      expect(batches[1]?.tool_decisions).toEqual([report("b")]);
    });

    test("are sent again with a batch that is retried, and dropped once it is acknowledged", async () => {
      let attempts = 0;
      const { batches, publisher: events } = publisher(async (request) => {
        attempts += 1;
        if (attempts === 1) {
          throw new WorkerGatewayRequestError(503, null, "gateway down", true);
        }
        return accepted(request);
      });
      events.audit(report("a"), "1");
      events.publish([systemEvent("x")], "1");
      await events.idle();
      expect(batches.map((batch) => batch.tool_decisions)).toEqual([
        [report("a")],
        [report("a")],
      ]);

      events.publish([systemEvent("y")], "1");
      await events.idle();
      expect(batches[2]).not.toHaveProperty("tool_decisions");
    });

    test("leave the field out when there is nothing to report, so an older API is unaffected", async () => {
      const { batches, publisher: events } = publisher(async (request) =>
        accepted(request),
      );
      events.publish([systemEvent("x")], "1");
      await events.idle();
      expect(batches[0]).not.toHaveProperty("tool_decisions");
    });

    test("an abandoned stream forgets them", async () => {
      const { batches, publisher: events } = publisher(async (request) =>
        accepted(request),
      );
      events.audit(report("a"), "1");
      events.abandon("lost");
      events.audit(report("b"), "1");
      events.publish([systemEvent("x")], "1");
      await events.idle().catch(() => {});
      expect(batches).toHaveLength(0);
    });
  });

  test("strips the frame cursor that is not this stream's", async () => {
    const { batches, publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    events.publish([systemEvent("sdk:0:1")], "1");
    await events.idle();

    expect(batches[0]?.events[0]).not.toHaveProperty("id");
  });
});
