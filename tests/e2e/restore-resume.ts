import { Api, e2eEnv, e2eStack, poll, scripted, type Turn } from "./client.ts";

/**
 * The public-API half of tests/e2e/restore-resume.sh: each step
 * the script runs against a stack, one subcommand per step, printing what
 * it saw as one JSON line for the run record and throwing when the stack
 * disagrees. The script does the rest — backup, restore, and reading the
 * checkpoints the two stacks committed.
 *
 *   bun run tests/e2e/restore-resume.ts turns
 *   bun run tests/e2e/restore-resume.ts pause <session>
 *   bun run tests/e2e/restore-resume.ts resume <session>
 */
const api = new Api(await e2eStack());

const bash = (command: string) => ({
  tool: "Bash",
  input: { command, description: command },
});

/** The prompts of the turns before the backup, in order. */
const BEFORE = ["rr1", "rr2"];
const AFTER = "rr3";

/** Settles a turn, allowing whatever it asks on the way. */
async function settle(sessionId: string, turnId: string): Promise<Turn> {
  return poll(`turn ${turnId} of ${sessionId}`, 300_000, async () => {
    const turn = await api.turn(sessionId, turnId);
    if (!["queued", "running", "needs_input"].includes(turn.status)) {
      return turn;
    }
    for (const request of await api.pending(sessionId)) {
      if (request.turn_id === turnId) {
        await api.allow(sessionId, request.request_id);
      }
    }
    return null;
  });
}

async function completed(sessionId: string, turnId: string): Promise<Turn> {
  const turn = await settle(sessionId, turnId);
  if (turn.status !== "completed") {
    throw new Error(`turn ${turnId} ended ${JSON.stringify(turn)}`);
  }
  return turn;
}

type ModelCall = {
  at: string;
  history: string[];
  spec_id: string | null;
  step: number | null;
};

async function modelCalls(): Promise<ModelCall[]> {
  const response = await fetch(`${e2eEnv().messagesUrl}/requests`);
  const calls = (await response.json()) as ModelCall[];
  return calls.filter((call) => call.spec_id !== null);
}

async function turns(): Promise<unknown> {
  // Two turns that each change the workspace, so a replayed input would
  // show in the file as well as in the model calls.
  const created = await api.createSession(
    scripted("rr1", [bash("echo alpha | tee hello.txt")], "wrote alpha"),
  );
  if (created.status !== 201) {
    throw new Error(`create answered ${created.status}`);
  }
  const sessionId = created.body.session_id;
  await completed(sessionId, "1");
  const second = await api.send(
    sessionId,
    scripted("rr2", [bash("echo beta | tee -a hello.txt")], "wrote beta"),
  );
  await completed(sessionId, second.turn_id);
  return {
    session_id: sessionId,
    turns: [
      await api.turn(sessionId, "1"),
      await api.turn(sessionId, second.turn_id),
    ],
    model_calls: await modelCalls(),
  };
}

async function pause(sessionId: string): Promise<unknown> {
  await api.sessionUntil(
    sessionId,
    "is idle",
    (s) => s.status === "idle" && s.queued_turn_count === 0,
  );
  const before = await api.session(sessionId);
  const response = await api.control(sessionId, "pause", {
    expected_revision: before.revision,
    reason: "restore-resume e2e",
  });
  if (response.status !== 202) {
    throw new Error(`pause answered ${response.status}`);
  }
  const paused = await api.sessionUntil(
    sessionId,
    "is paused with a checkpoint",
    (s) => s.admission_state === "paused" && s.checkpoint_revision !== null,
    300_000,
  );
  return { paused };
}

async function resume(sessionId: string): Promise<unknown> {
  const restored = await api.session(sessionId);
  if (restored.admission_state !== "paused") {
    throw new Error(`restored session is ${JSON.stringify(restored)}`);
  }
  const restoredTurns = await Promise.all(
    BEFORE.map((_, index) => api.turn(sessionId, String(index + 1))),
  );
  if (restoredTurns.some((turn) => turn.status !== "completed")) {
    throw new Error(`restored turns: ${JSON.stringify(restoredTurns)}`);
  }
  // A new stack's fake Messages API has seen nothing: every call it records
  // from here on is this stack's.
  const stale = await modelCalls();
  if (stale.length > 0) {
    throw new Error(`model calls before resume: ${JSON.stringify(stale)}`);
  }
  const response = await api.control(sessionId, "resume", {
    expected_revision: restored.revision,
  });
  if (response.status !== 202) {
    throw new Error(`resume answered ${response.status}`);
  }
  const active = await api.sessionUntil(
    sessionId,
    "is active again",
    (s) => s.admission_state === "active",
    300_000,
  );
  const next = await api.send(
    sessionId,
    scripted(AFTER, [bash("cat hello.txt")], "read it back"),
  );
  if (next.turn_id !== String(BEFORE.length + 1)) {
    throw new Error(`the resumed turn is ${next.turn_id}`);
  }
  const turn = await completed(sessionId, next.turn_id);
  const result = (
    await api.events(
      sessionId,
      (event) =>
        event.event === "tool_result" && event.data.turn_id === next.turn_id,
    )
  ).at(-1);
  // Written once each before the backup; a replayed turn 2 would append a
  // second beta, a fresh workspace would have no file at all.
  if (result?.data.data.content !== "alpha\nbeta") {
    throw new Error(
      `cat hello.txt answered ${JSON.stringify(result?.data.data ?? null)}`,
    );
  }
  const calls = await modelCalls();
  const replayed = calls.filter((call) => call.spec_id !== AFTER);
  if (replayed.length > 0) {
    throw new Error(`an earlier input ran again: ${JSON.stringify(replayed)}`);
  }
  // The engine sent the first two prompts as history: it resumed the
  // conversation instead of starting a new one.
  const first = calls.find((call) => call.step === 0);
  if (JSON.stringify(first?.history) !== JSON.stringify([...BEFORE, AFTER])) {
    throw new Error(`the resumed call's history is ${JSON.stringify(first)}`);
  }
  return {
    restored,
    active,
    turn,
    cat_output: result.data.data.content,
    model_calls: calls,
    earlier: await Promise.all(
      BEFORE.map((_, index) => api.turn(sessionId, String(index + 1))),
    ),
  };
}

const [command, sessionId] = process.argv.slice(2);
let result: unknown;
if (command === "turns") result = await turns();
else if (command === "pause" && sessionId) result = await pause(sessionId);
else if (command === "resume" && sessionId) result = await resume(sessionId);
else {
  console.error(
    "usage: restore-resume.ts turns | pause <session> | resume <session>",
  );
  process.exit(2);
}
console.log(JSON.stringify(result));
