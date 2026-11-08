import { describe, expect, test } from "bun:test";

import { TurnLedger } from "./turn-ledger.ts";

const ready = {
  status: "ready" as const,
  checkpoint: { engine: "claude", resume: "s1", sdkVersion: "0.3.319" },
};
const running = {
  status: "rejected" as const,
  reason: "turn_in_flight" as const,
  detail: "A turn is still running",
};

describe("turn ledger", () => {
  test("keeps rejecting until a result has consumed every queued uuid", () => {
    const ledger = new TurnLedger();
    expect(ledger.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "no_engine_session",
      detail: "No SDK session has started",
    });
    ledger.queued("a");
    ledger.queued("b");
    ledger.observe({ type: "system", subtype: "init", session_id: "s1" });
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "a",
    });
    expect(ledger.prepareCheckpoint()).toEqual(running);
    ledger.observe({ type: "assistant" });
    expect(ledger.prepareCheckpoint()).toEqual(running);
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "b",
    });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("one result can settle several sends folded into a single turn", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    ledger.queued("b");
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "b",
      user_message_uuids: ["a", "b"],
    });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("settles every input queued before the batch's last uuid, past the 64-entry cap", () => {
    const ledger = new TurnLedger("s1");
    const uuids = Array.from({ length: 70 }, (_, i) => `u${i}`);
    for (const uuid of uuids) ledger.queued(uuid);
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "u64",
      user_message_uuids: uuids.slice(1, 65),
    });
    expect(ledger.prepareCheckpoint()).toEqual(running);
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "u69",
      user_message_uuids: uuids.slice(65),
    });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("release() drops an input that never reached the engine", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    ledger.release("a");
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("a result without uuid attribution settles nothing", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    ledger.observe({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      queued_turn_count: 1,
      session_id: "s1",
    });
    expect(ledger.prepareCheckpoint()).toEqual(running);
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "a",
    });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("refuses to queue a uuid that is already pending", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    expect(() => ledger.queued("a")).toThrow("Input uuid is already queued: a");
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "a",
    });
    ledger.queued("a");
    expect(ledger.prepareCheckpoint()).toEqual(running);
  });

  test("informational frames after a result do not reopen an idle turn", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "a",
    });
    ledger.observe({ type: "tool_use_summary" });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("a resumed run is checkpointable until new input is queued", () => {
    const ledger = new TurnLedger("s1");
    expect(ledger.prepareCheckpoint()).toEqual(ready);
    ledger.queued("a");
    expect(ledger.prepareCheckpoint()).toEqual(running);
  });

  test("refuses to checkpoint a run whose mirror dropped a batch, however the turn ended", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    ledger.observe({
      type: "system",
      subtype: "mirror_error",
      session_id: "s1",
      error: "append rejected",
      key: { projectKey: "-workspace", sessionId: "s1" },
    });
    // The SDK keeps going and the turn comes back successful; the transcript in
    // the store is still short the entries that batch carried.
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "a",
    });

    expect(ledger.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "mirror_error",
      detail: "Transcript mirror dropped a root batch: append rejected",
    });
  });

  test("names the subagent whose mirror failed and keeps the first failure", () => {
    const ledger = new TurnLedger("s1");
    ledger.observe({
      type: "system",
      subtype: "mirror_error",
      session_id: "s1",
      error: "timed out",
      key: { projectKey: "-workspace", sessionId: "s1", subpath: "agents/rev" },
    });
    ledger.observe({
      type: "system",
      subtype: "mirror_error",
      session_id: "s1",
      error: "second failure",
      key: { projectKey: "-workspace", sessionId: "s1" },
    });

    expect(ledger.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "mirror_error",
      detail:
        "Transcript mirror dropped a subagent agents/rev batch: timed out",
    });
  });

  test("allows exactly one event consumer", () => {
    const ledger = new TurnLedger();
    ledger.claimConsumer();
    expect(() => ledger.claimConsumer()).toThrow(
      "AgentRun events can only be consumed once",
    );
  });
});

describe("checkpoint quiescence", () => {
  test("a tool the gate admitted blocks a checkpoint until a hook settles it", () => {
    const ledger = new TurnLedger("s1");
    expect(ledger.toolStarting("toolu_1")).toEqual({ allowed: true });
    expect(ledger.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "tool_in_flight",
      detail: "1 tool call(s) still running",
    });
    ledger.toolSettled("toolu_1");
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("a tool_result settles a tool no hook reported the end of", () => {
    const ledger = new TurnLedger("s1");
    ledger.toolStarting("toolu_1");
    ledger.toolStarting("toolu_2");
    ledger.observe({
      type: "user",
      parent_tool_use_id: "toolu_task",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", is_error: true },
        ],
      },
    });
    expect(ledger.prepareCheckpoint()).toMatchObject({
      reason: "tool_in_flight",
    });
    ledger.observe({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_2" }],
      },
    });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("an open permission callback is a tool about to run", () => {
    const ledger = new TurnLedger("s1");
    expect(ledger.permissionStarting("toolu_1")).toEqual({ allowed: true });
    expect(ledger.prepareCheckpoint()).toMatchObject({
      reason: "tool_in_flight",
    });
    ledger.permissionSettled("toolu_1");
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("parkable while every admitted tool waits on its permission callback", () => {
    const ledger = new TurnLedger("s1");
    expect(ledger.parkable()).toEqual({ ok: true, resume: "s1" });
    ledger.toolStarting("toolu_ask");
    ledger.permissionStarting("toolu_ask");
    expect(ledger.parkable()).toEqual({ ok: true, resume: "s1" });
    // An auto-allowed sibling is executing: a park would cut it mid-write.
    ledger.toolStarting("toolu_run");
    expect(ledger.parkable()).toEqual({ ok: false, reason: "tool_executing" });
    ledger.toolSettled("toolu_run");
    expect(ledger.parkable()).toEqual({ ok: true, resume: "s1" });
    // An allowed callback hands its tool over to run.
    ledger.permissionSettled("toolu_ask");
    expect(ledger.parkable()).toEqual({ ok: false, reason: "tool_executing" });
  });

  test("a turn whose mirror dropped a batch cannot park on a checkpoint", () => {
    const ledger = new TurnLedger("s1");
    ledger.observe({
      type: "system",
      subtype: "mirror_error",
      error: "bucket unreachable",
    });
    expect(ledger.parkable()).toEqual({
      ok: false,
      reason: "checkpoint_unavailable",
      detail: "Transcript mirror dropped a root batch: bucket unreachable",
    });
    expect(new TurnLedger().parkable()).toMatchObject({
      reason: "checkpoint_unavailable",
    });
  });

  test("a background task keeps a turn from parking", () => {
    const ledger = new TurnLedger("s1");
    ledger.observe({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "bash_1" }],
    });
    expect(ledger.parkable()).toEqual({ ok: false, reason: "tool_executing" });
  });

  test("a background task keeps writing after the turn's result", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    ledger.observe({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "bash_1", task_type: "local_bash", description: "" }],
    });
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "a",
    });
    expect(ledger.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "background_writer",
      detail: "Background task(s) still running: bash_1",
    });
    // Replace semantics: the next level names every task still alive.
    ledger.observe({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("a lost stream proves nothing about the tools and tasks it left", () => {
    const ledger = new TurnLedger("s1");
    ledger.toolStarting("toolu_1");
    ledger.streamEnded();
    expect(ledger.prepareCheckpoint()).toMatchObject({
      reason: "tool_in_flight",
    });
    ledger.toolSettled("toolu_1");
    ledger.observe({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "agent_1", task_type: "local_agent", ambient: true }],
    });
    ledger.streamEnded();
    // Ambient only means "not activity"; it says nothing about writing.
    expect(ledger.prepareCheckpoint()).toMatchObject({
      reason: "background_writer",
    });
  });

  test("a backgrounded tool's placeholder result settles the call, not its task", () => {
    const ledger = new TurnLedger("s1");
    ledger.toolStarting("toolu_bg");
    ledger.observe({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "bash_1", task_type: "local_bash" }],
    });
    ledger.observe({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_bg" }],
      },
    });
    expect(ledger.prepareCheckpoint()).toMatchObject({
      reason: "background_writer",
    });
  });
});

describe("checkpoint lease", () => {
  test("refuses every new tool, permission and input while it is held", () => {
    const ledger = new TurnLedger("s1");
    const grant = ledger.leaseCheckpoint();
    expect(grant.preparation).toEqual(ready);
    const refused = {
      allowed: false,
      message:
        "A checkpoint is being saved; no tool may start until it is committed",
    };
    expect(ledger.toolStarting("toolu_1")).toEqual(refused);
    expect(ledger.permissionStarting("toolu_2")).toEqual(refused);
    expect(() => ledger.queued("next")).toThrow(
      "A checkpoint is being captured; input next waits",
    );
    grant.lease?.release();
    expect(ledger.toolStarting("toolu_1")).toEqual({ allowed: true });
  });

  test("is not granted while the run is not quiescent", () => {
    const ledger = new TurnLedger("s1");
    ledger.toolStarting("toolu_1");
    expect(ledger.leaseCheckpoint()).toEqual({
      lease: null,
      preparation: {
        status: "rejected",
        reason: "tool_in_flight",
        detail: "1 tool call(s) still running",
      },
    });
    // A refused lease leaves nothing held: the tool that is running can end
    // and another can start.
    ledger.toolSettled("toolu_1");
    expect(ledger.toolStarting("toolu_2")).toEqual({ allowed: true });
  });

  test("a second checkpoint is blocked while the first holds the lease", () => {
    const ledger = new TurnLedger("s1");
    const first = ledger.leaseCheckpoint();
    const held = {
      status: "rejected" as const,
      reason: "checkpoint_lease_held" as const,
      detail: "Another checkpoint holds the lease",
    };
    expect(ledger.leaseCheckpoint()).toEqual({
      lease: null,
      preparation: held,
    });
    expect(ledger.prepareCheckpoint()).toEqual(held);
    first.lease?.release();
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("a stale grant's release does not release a later lease", () => {
    const ledger = new TurnLedger("s1");
    const first = ledger.leaseCheckpoint();
    first.lease?.release();
    const second = ledger.leaseCheckpoint();
    first.lease?.release();
    expect(ledger.prepareCheckpoint()).toMatchObject({
      reason: "checkpoint_lease_held",
    });
    second.lease?.release();
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });
});

describe("approval-wait checkpoint", () => {
  test("is ready mid-turn once every admitted call has settled or waits on a person", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    expect(ledger.prepareCheckpoint("approval_wait")).toMatchObject({
      reason: "turn_in_flight",
      detail: "No permission callback is waiting",
    });
    ledger.toolStarting("toolu_ask");
    ledger.permissionStarting("toolu_ask");
    ledger.toolStarting("toolu_run");
    expect(ledger.prepareCheckpoint("approval_wait")).toMatchObject({
      reason: "tool_in_flight",
    });
    ledger.toolSettled("toolu_run");
    expect(ledger.prepareCheckpoint("approval_wait")).toEqual(ready);
    // The turn itself is still running: a turn-end checkpoint is not.
    expect(ledger.prepareCheckpoint().status).toBe("rejected");
    expect(ledger.awaitingIds()).toEqual(["toolu_ask"]);

    const grant = ledger.leaseCheckpoint("approval_wait");
    expect(grant.preparation).toEqual(ready);
    expect(ledger.toolStarting("toolu_next").allowed).toBe(false);
    expect(ledger.prepareCheckpoint("approval_wait")).toMatchObject({
      reason: "checkpoint_lease_held",
    });
    grant.lease?.release();
    expect(ledger.toolStarting("toolu_next").allowed).toBe(true);
  });

  test("names the settled calls whose results the mirror does not hold, until it does", () => {
    const ledger = new TurnLedger("s1");
    ledger.toolStarting("toolu_1");
    ledger.toolSettled("toolu_1");
    ledger.observe({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_2" }],
      },
    });
    expect(ledger.unmirroredResults(new Set())).toEqual(["toolu_1", "toolu_2"]);
    expect(ledger.unmirroredResults(new Set(["toolu_1"]))).toEqual(["toolu_2"]);
    // Forgotten once mirrored, whatever a later caller passes.
    expect(ledger.unmirroredResults(new Set())).toEqual(["toolu_2"]);
  });
});
