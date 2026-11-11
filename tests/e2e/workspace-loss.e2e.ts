import { describe, expect, test } from "bun:test";
import {
  Api,
  bash,
  type ErrorBody,
  e2eStack,
  poll,
  type SessionDetail,
  type Step,
  scripted,
  write,
} from "./client.ts";

/**
 * A session that loses its workspace volume while paused comes back from its
 * last committed checkpoint, with and without a repository, on the stack
 * tests/e2e/run.sh started. Deleting the volume is test scaffolding, the
 * one step here that is not public HTTP: it stands in for a lost disk or a
 * reclaimed volume, which no API call causes.
 */
const api = new Api(await e2eStack());
const TIMEOUT = 600_000;
const WORKSPACE = "/workspace";
/**
 * The fake Messages API keeps every call it served, so a rerun against the
 * same stack (E2E_UP_ONLY=1) would read the last run's calls by spec id.
 */
const RUN = crypto.randomUUID().slice(0, 8);
const spec = (name: string) => `wl-${name}-${RUN}`;

/**
 * Every line of `path`, read from disk. Not Read: the resumed engine
 * remembers writing the file and answers a Read of it with "file unchanged
 * since your last Read" instead of its content.
 */
const linesOf = (path: string): Step => ({
  tool: "Grep",
  input: { pattern: ".", path, output_mode: "content" },
});

const installation = process.env.EXECUTION_INSTALLATION_ID;
if (!installation) {
  throw new Error(
    "EXECUTION_INSTALLATION_ID is unset: run tests/e2e/run.sh, or source its vars.sh (E2E_UP_ONLY=1)",
  );
}

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, stdout, stderr };
}

/** The session's workspace volumes, found by the labels the backend sets. */
async function workspaceVolumes(sessionId: string): Promise<string[]> {
  const volumeLabelNamespace =
    process.env.EXECUTION_VOLUME_LABEL_NAMESPACE || "werft";
  const listed = await docker(
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=${volumeLabelNamespace}.installation=${installation}`,
    "--filter",
    `label=${volumeLabelNamespace}.session-id=${sessionId}`,
  );
  if (listed.status !== 0)
    throw new Error(`docker volume ls: ${listed.stderr}`);
  return listed.stdout.split("\n").filter((name) => name !== "");
}

/**
 * Removes the paused session's one workspace volume and returns its name.
 * The worker's container can outlive the pause by a moment, and the volume
 * is in use until it is gone.
 */
async function loseWorkspace(sessionId: string): Promise<string> {
  const [volume, ...more] = await workspaceVolumes(sessionId);
  expect(volume).toBeDefined();
  expect(more).toEqual([]);
  const name = volume as string;
  await poll(`removal of ${name}`, 120_000, async () => {
    const removed = await docker("volume", "rm", name);
    if (removed.status === 0) return true;
    if (!removed.stderr.includes("in use")) {
      throw new Error(`docker volume rm ${name}: ${removed.stderr}`);
    }
    return null;
  });
  expect(await workspaceVolumes(sessionId)).toEqual([]);
  return name;
}

async function completedWithCheckpoint(sessionId: string, turnId: string) {
  const turn = await api.settleAllowing(sessionId, turnId);
  expect(turn.status).toBe("completed");
  return api.sessionUntil(
    sessionId,
    `checkpoints turn ${turnId}`,
    (s) => s.durability.last_checkpointed_turn_id === turnId,
  );
}

/** pause → lose the workspace volume → resume; returns the lost volume. */
async function pauseLoseResume(session: SessionDetail): Promise<string> {
  const pause = await api.control(session.id, "pause", {
    expected_revision: session.revision,
    reason: "e2e: workspace loss",
  });
  expect(pause.status).toBe(202);
  await api.sessionUntil(
    session.id,
    "is paused",
    (s) => s.admission_state === "paused",
  );
  const lost = await loseWorkspace(session.id);
  const resume = await api.control(session.id, "resume", {
    expected_revision: (await api.session(session.id)).revision,
  });
  expect(resume.status).toBe(202);
  await api.sessionUntil(
    session.id,
    "is active again",
    (s) => s.admission_state === "active",
  );
  return lost;
}

async function toolResultText(
  sessionId: string,
  turnId: string,
): Promise<string> {
  const result = (
    await api.events(
      sessionId,
      (event) => event.event === "tool_result" && event.data.turn_id === turnId,
    )
  ).at(-1);
  return JSON.stringify(result?.data.data);
}

/**
 * The turn after the restore: its tool result reads back what the turn
 * before the loss wrote, the engine sent that turn's prompt as history, and
 * the workspace is a new volume.
 */
async function expectRestored(
  sessionId: string,
  lost: string,
  before: string,
  after: string,
  turnId: string,
  contents: string[],
) {
  await completedWithCheckpoint(sessionId, turnId);
  const text = await toolResultText(sessionId, turnId);
  for (const content of contents) expect(text).toContain(content);
  const [first] = await api.modelCalls(after);
  expect(first?.history).toEqual([before, after]);
  const volumes = await workspaceVolumes(sessionId);
  expect(volumes).toHaveLength(1);
  expect(volumes[0]).not.toBe(lost);
  console.log(
    `workspace loss restored ${sessionId}: ${lost} -> ${volumes[0]}, history ${JSON.stringify(first?.history)}`,
  );
}

function createWithoutRepository(message: string) {
  return api.createSession(message, undefined, null);
}

describe("sessions without a repository", () => {
  test(
    "a question with no file written still commits a checkpoint",
    async () => {
      const created = await createWithoutRepository(
        scripted(spec("qa"), [], "an answer, no files"),
      );
      expect(created.status).toBe(201);
      const sessionId = created.body.session_id;
      const session = await completedWithCheckpoint(sessionId, "1");
      expect(session.repository_id).toBeNull();
      expect(session.checkpoint_revision).not.toBeNull();
      console.log(
        `none Q&A ${sessionId}: checkpoint_revision ${session.checkpoint_revision}`,
      );
    },
    TIMEOUT,
  );

  test(
    "a push request is 409 PUSH_SOURCE_MISSING and leaves a failed receipt",
    async () => {
      const created = await createWithoutRepository(
        scripted(spec("push"), [], "nothing to push"),
      );
      const sessionId = created.body.session_id;
      await completedWithCheckpoint(sessionId, "1");
      const push = await api.request<ErrorBody>(
        "POST",
        `/v1/sessions/${sessionId}/push-requests`,
        {},
      );
      expect(push.status).toBe(409);
      expect(push.body.error.code).toBe("PUSH_SOURCE_MISSING");
      expect(push.body.error.details).toMatchObject({
        refusal: "no_repository",
      });
      const receiptId = String(push.body.error.details?.receipt_id);
      expect(await api.receipt(receiptId)).toMatchObject({
        operation: "request_push",
        status: "failed",
        result: { verdict: "refuse", refusal: "no_repository" },
      });
      console.log(
        `none push ${sessionId}: 409 PUSH_SOURCE_MISSING, receipt ${receiptId} failed`,
      );
    },
    TIMEOUT,
  );

  test(
    "out/ written before the workspace volume is lost comes back on resume",
    async () => {
      const report = `${WORKSPACE}/out/report.md`;
      const created = await createWithoutRepository(
        scripted(
          spec("n1"),
          [write(report, "report from turn one\n")],
          "wrote the report",
        ),
      );
      expect(created.status).toBe(201);
      const sessionId = created.body.session_id;
      const lost = await pauseLoseResume(
        await completedWithCheckpoint(sessionId, "1"),
      );
      const next = await api.send(
        sessionId,
        scripted(spec("n2"), [linesOf(report)], "read it back"),
      );
      await expectRestored(
        sessionId,
        lost,
        spec("n1"),
        spec("n2"),
        next.turn_id,
        ["report from turn one"],
      );
    },
    TIMEOUT,
  );
});

describe("sessions with a repository", () => {
  test(
    "files written before the workspace volume is lost come back on resume",
    async () => {
      const created = await api.createSession(
        scripted(
          spec("r1"),
          [
            bash(
              "mkdir -p out && echo repo-report > out/report.md && echo repo-notes > notes.txt",
            ),
          ],
          "wrote two files",
        ),
      );
      expect(created.status).toBe(201);
      const sessionId = created.body.session_id;
      const lost = await pauseLoseResume(
        await completedWithCheckpoint(sessionId, "1"),
      );
      const next = await api.send(
        sessionId,
        scripted(
          spec("r2"),
          [bash("cat out/report.md notes.txt")],
          "read back",
        ),
      );
      await expectRestored(
        sessionId,
        lost,
        spec("r1"),
        spec("r2"),
        next.turn_id,
        ["repo-report", "repo-notes"],
      );
    },
    TIMEOUT,
  );
});
