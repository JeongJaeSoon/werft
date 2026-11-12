import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { Api, e2eStack } from "../e2e/client.ts";
import { docker } from "../conformance/docker.ts";
import { scriptId } from "../conformance/engine.ts";
import { engineFromEnv } from "../conformance/engines.ts";

/**
 * One stage of the upgrade tests/compat/run.sh walks a stack through
 * (docs/contributing/decisions/worker-compat.md § 4.1). Session A lives
 * through all three; what a stage learned for the next is kept in
 * COMPAT_STATE.
 *
 *   1  the old release: A's turn 1 completes and is checkpointed
 *   2  the new schema under the old control-host: A's turn 2 completes and
 *      is checkpointed, then A is paused and its worker goes away
 *   3  the new control-host with the old worker and proxy: a new session B
 *      completes turn 1 on the old worker, and A resumes on a new old
 *      worker whose turn 3 sees turns 1 and 2 in its history
 */
const stage = process.env.COMPAT_STAGE;
const statePath = process.env.COMPAT_STATE;
const oldWorker = process.env.COMPAT_OLD_WORKER;
if (!statePath || !oldWorker || !["1", "2", "3"].includes(stage ?? "")) {
  throw new Error(
    "COMPAT_STAGE (1-3), COMPAT_STATE and COMPAT_OLD_WORKER are set by tests/compat/run.sh",
  );
}

type State = {
  sessionA: string;
  scripts: string[];
  generation?: number;
};
const readState = (): State => JSON.parse(readFileSync(statePath, "utf8"));
const writeState = (state: State) =>
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

const engine = engineFromEnv();
const api = new Api(
  await e2eStack({ needsMessages: false, connectionId: engine.connectionId }),
);
const TIMEOUT = 600_000;

/** The session's worker containers, stopped ones included, newest first. */
async function workers(
  sessionId: string,
): Promise<{ id: string; generation: number; running: boolean }[]> {
  const text = await docker([
    "ps",
    "-a",
    "--filter",
    `label=werft.session-id=${sessionId}`,
    "--format",
    '{{.ID}} {{.Label "werft.generation"}} {{.State}}',
  ]);
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [id = "", generation = "", state = ""] = line.trim().split(" ");
      return { id, generation: Number(generation), running: state === "running" };
    })
    .sort((a, b) => b.generation - a.generation);
}

/** The image a container was started from, as the daemon's image id. */
async function imageOf(container: string): Promise<string> {
  return (
    await docker(["inspect", "--format", "{{.Image}}", container])
  ).trim();
}

async function oldWorkerImageId(): Promise<string> {
  return (
    await docker(["image", "inspect", "--format", "{{.Id}}", oldWorker ?? ""])
  ).trim();
}

/** Sends the next scripted turn and waits until it is checkpointed. */
async function checkpointedTurn(
  sessionId: string,
  script: string,
  turnId: string,
): Promise<void> {
  const sent = await api.send(
    sessionId,
    engine.prompt({ id: script, commands: [], final: script }),
  );
  expect(sent.turn_id).toBe(turnId);
  expect((await api.settledTurn(sessionId, turnId)).status).toBe("completed");
  await api.sessionUntil(
    sessionId,
    `has checkpointed turn ${turnId}`,
    (s) => s.durability.last_checkpointed_turn_id === turnId,
  );
}

describe(`upgrade stage ${stage} on ${engine.runtimeKind}`, () => {
  if (stage === "1") {
    test(
      "the old release completes and checkpoints session A's first turn",
      async () => {
        const script = scriptId("compat-1");
        const created = await api.createSession(
          engine.prompt({ id: script, commands: [], final: script }),
          undefined,
          engine.repositoryId,
        );
        expect(created.status).toBe(201);
        const sessionA = created.body.session_id;
        expect((await api.settledTurn(sessionA, "1")).status).toBe(
          "completed",
        );
        await api.sessionUntil(
          sessionA,
          "has checkpointed turn 1",
          (s) => s.durability.last_checkpointed_turn_id === "1",
        );
        writeState({ sessionA, scripts: [script] });
      },
      TIMEOUT,
    );
  }

  if (stage === "2") {
    test(
      "the old control-host on the new schema completes turn 2, then pauses session A",
      async () => {
        const state = readState();
        const script = scriptId("compat-2");
        await checkpointedTurn(state.sessionA, script, "2");
        const [current] = await workers(state.sessionA);
        expect(current).toBeDefined();

        const session = await api.session(state.sessionA);
        const pause = await api.control(state.sessionA, "pause", {
          expected_revision: session.revision,
          reason: "worker compatibility",
        });
        expect(pause.status).toBe(202);
        await api.sessionUntil(
          state.sessionA,
          "is paused",
          (s) => s.admission_state === "paused",
        );
        // The resume in stage 3 must start a worker of its own.
        const deadline = Date.now() + 120_000;
        while ((await workers(state.sessionA)).some((w) => w.running)) {
          if (Date.now() > deadline) {
            throw new Error("session A's worker is still running after the pause");
          }
          await Bun.sleep(1_000);
        }
        writeState({
          ...state,
          scripts: [...state.scripts, script],
          generation: current?.generation,
        });
      },
      TIMEOUT,
    );
  }

  if (stage === "3") {
    test(
      "the new control-host completes a new session's first turn on the old worker",
      async () => {
        const script = scriptId("compat-b");
        const created = await api.createSession(
          engine.prompt({ id: script, commands: [], final: script }),
          undefined,
          engine.repositoryId,
        );
        expect(created.status).toBe(201);
        const sessionB = created.body.session_id;
        expect((await api.settledTurn(sessionB, "1")).status).toBe(
          "completed",
        );
        const [worker] = await workers(sessionB);
        expect(worker).toBeDefined();
        expect(await imageOf(worker?.id ?? "")).toBe(await oldWorkerImageId());
      },
      TIMEOUT,
    );

    test(
      "session A resumes from its checkpoint on a new old worker and continues the conversation",
      async () => {
        const state = readState();
        const resume = await api.control(state.sessionA, "resume", {
          expected_revision: (await api.session(state.sessionA)).revision,
        });
        expect(resume.status).toBe(202);
        await api.sessionUntil(
          state.sessionA,
          "is active again",
          (s) => s.admission_state === "active",
        );
        const script = scriptId("compat-3");
        await checkpointedTurn(state.sessionA, script, "3");

        // A worker that survived the pause would answer from memory.
        const [worker] = await workers(state.sessionA);
        expect(worker?.generation).toBeGreaterThan(state.generation ?? 0);
        expect(await imageOf(worker?.id ?? "")).toBe(await oldWorkerImageId());

        const calls = await engine.modelCalls(script);
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
          for (const earlier of state.scripts) {
            expect(call.history).toContain(earlier);
          }
        }
      },
      TIMEOUT,
    );
  }
});
