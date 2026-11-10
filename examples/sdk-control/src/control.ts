import {
  isApiError,
  type Receipt,
  type Session,
  type SessionId,
  TurnBlockedError,
  type TurnId,
  Werft,
  waitForReceipt,
  waitForTurn,
} from "@werft-ai/sdk";

const client = new Werft();
const signal = AbortSignal.timeout(10 * 60_000);
const agent_release_id = process.env.WERFT_AGENT_RELEASE_ID;
if (!agent_release_id) {
  throw new Error("set WERFT_AGENT_RELEASE_ID to the agent release to run");
}

const script = (id: string, final: string, finalDelayMs?: number) =>
  `GATE-SPEC ${JSON.stringify({ id, steps: [], final, ...(finalDelayMs ? { finalDelayMs } : {}) })}`;
// The fake model holds its answer this long: long enough to act on the turn.
const SLOW = 300_000;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    signal.throwIfAborted();
  }
}

async function settled(accepted: { receipt_id: string }): Promise<Receipt> {
  const receipt = await waitForReceipt(client, accepted.receipt_id, { signal });
  if (receipt.status !== "succeeded")
    throw new Error(`${receipt.operation} receipt ${receipt.status}`);
  return receipt;
}

async function run(): Promise<void> {
  const created = await client.sessions.create(
    { agent_release_id, message: script("ctl1", "ready") },
    { signal },
  );
  const id: SessionId = created.session_id;
  const get = () => client.sessions.get(id, { signal });
  const send = async (message: string) =>
    (await client.sessions.messages.send(id, { message }, { signal })).turn_id;
  const turn = (turnId: TurnId) => waitForTurn(client, id, turnId, { signal });
  const running = (turnId: TurnId) =>
    until(
      () => client.sessions.turns.get(id, turnId, { signal }),
      (t) => t.status === "running",
    );
  console.log(`session ${id}: created`);
  console.log(`turn 1: ${(await turn(created.turn_id)).status}`);

  // 1. interrupt stops the running turn; the worker stays for the next one.
  const slow = await send(script("ctl2", "too late", SLOW));
  await running(slow);
  const interrupt = await client.sessions.interrupt(
    id,
    { target_turn_id: slow },
    { signal },
  );
  await settled(interrupt);
  console.log(`interrupt: turn ${slow} ${(await turn(slow)).status}`);

  // 2. Controls carry the revision the caller decided on. The SDK neither
  // fills it in nor retries a REVISION_CONFLICT.
  const stale = await client.sessions
    .pause(id, { expected_revision: (await get()).revision + 1 }, { signal })
    .catch((error: unknown) => error);
  if (!isApiError(stale, "REVISION_CONFLICT")) throw stale;
  console.log(`pause with a wrong revision: ${stale.status} ${stale.code}`);

  // 3. pause lets the running turn finish and keeps the queued one for
  // resume. Waiting on the queued turn now cannot end: TurnBlockedError.
  const draining = await send(
    script("ctl3", "finished before the pause", 8_000),
  );
  const queued = await send(script("ctl4", "after resume"));
  await running(draining);
  await settled(
    await client.sessions.pause(
      id,
      { expected_revision: (await get()).revision, reason: "control sample" },
      { signal },
    ),
  );
  const paused = await get();
  console.log(
    `pause: admission ${paused.admission_state}, turn ${draining} ${(await client.sessions.turns.get(id, draining, { signal })).status}, turn ${queued} ${(await client.sessions.turns.get(id, queued, { signal })).status}`,
  );
  const blocked = await turn(queued).catch((error: unknown) => error);
  if (!(blocked instanceof TurnBlockedError)) throw blocked;
  console.log(
    `wait on turn ${queued}: ${blocked.code} (${blocked.details.admission_state})`,
  );
  const refused = await send("while paused").catch((error: unknown) => error);
  if (!isApiError(refused, "SESSION_PAUSED")) throw refused;
  console.log(`message while paused: ${refused.status} ${refused.code}`);
  await settled(
    await client.sessions.resume(
      id,
      { expected_revision: (await get()).revision },
      { signal },
    ),
  );
  console.log(`resume: turn ${queued} ${(await turn(queued)).status}`);

  // 4. terminate kills the running turn; its outcome is unknown until a
  // person decides. abandon marks it cancelled, then the session resumes.
  const doomed = await send(script("ctl6", "never", SLOW));
  await running(doomed);
  const terminated = await client.sessions.terminate(
    id,
    { expected_revision: (await get()).revision, reason: "control sample" },
    { signal },
  );
  console.log(
    `terminate: receipt ${terminated.receipt_status}, external effects reverted ${terminated.external_effects_reverted}`,
  );
  const recovering: Session = await until(
    get,
    (s) => s.admission_state === "recovery_required",
  );
  const lost = await client.sessions.turns.get(id, doomed, { signal });
  console.log(
    `session: ${recovering.status}/${recovering.admission_state}, turn ${doomed} ${lost.status}`,
  );
  const decision = await settled(
    await client.sessions.recoveryDecisions.create(
      id,
      {
        decision: "abandon",
        expected_revision: recovering.revision,
        reason: "the slow call had no effect",
        target_turn_id: doomed,
      },
      { signal },
    ),
  );
  const { resumable } = decision.result as { resumable?: boolean };
  console.log(
    `recovery: abandon, turn ${doomed} ${(await client.sessions.turns.get(id, doomed, { signal })).status}, resumable ${resumable}`,
  );
  await settled(
    await client.sessions.resume(
      id,
      { expected_revision: (await get()).revision },
      { signal },
    ),
  );
  const last = await turn(await send(script("ctl7", "back again")));
  console.log(`after recovery: turn ${last.turn_id} ${last.status}`);
  if (last.status !== "completed")
    throw new Error("the session did not recover");

  await settled(
    await client.sessions.close(
      id,
      {
        expected_revision: (await get()).revision,
        reason: "control sample finished",
      },
      { signal },
    ),
  );
  console.log("close: receipt succeeded");
}

try {
  await run();
} catch (error) {
  if (isApiError(error))
    console.error(error.code, error.message, "request_id:", error.requestId);
  else console.error(error instanceof Error ? error.message : "Sample failed");
  process.exitCode = 1;
}
