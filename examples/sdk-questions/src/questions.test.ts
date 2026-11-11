import { expect, test } from "bun:test";
import {
  apiError,
  json,
  runSample,
  type Seen,
} from "../../testing/sample-server.ts";

const SAMPLE = `${import.meta.dir}/questions.ts`;
const SESSION = "fake-session";

const question = {
  request_id: "req-1",
  turn_id: "1",
  kind: "question",
  created_at: "2026-10-29T00:00:01Z",
  expires_at: "2026-10-29T00:30:01Z",
  questions: [
    {
      question_id: "q-1",
      prompt: "Which environment should the report cover?",
      options: [
        { option_id: "opt-staging", label: "staging" },
        { option_id: "opt-production", label: "production" },
      ],
      multi_select: false,
      allow_free_text: false,
    },
  ],
};
const write = (n: number) => ({
  request_id: `req-${n}`,
  turn_id: String(n),
  kind: "permission",
  tool: "Write",
  input: { file_path: "/workspace/notes.txt", content: "draft report\n" },
  created_at: `2026-10-29T00:00:0${n}Z`,
  expires_at: `2026-10-29T00:30:0${n}Z`,
});

function fakeQuestions(options: {
  lastTurn: "completed" | "failed";
  conflict?: [number, string];
}) {
  const [conflictStatus, conflictCode] = options.conflict ?? [
    409,
    "IDEMPOTENCY_CONFLICT",
  ];
  const requests = [question, write(2), write(3)];
  let turns = 1;
  const answers = new Map<string, unknown>();
  const route = (request: Seen) => {
    const { method, path, body } = request;
    if (method === "POST" && path === "/v1/sessions") {
      expect(body).toMatchObject({
        agent_release_id: "sha256:sample-release",
      });
      expect(body).not.toHaveProperty("repository_id");
      return json({ session_id: SESSION, turn_id: "1", status: "queued" }, 201);
    }
    if (method === "POST" && path.endsWith("/messages"))
      return json({ turn_id: String(++turns), status: "queued" }, 202);
    if (path.endsWith("/pending-requests"))
      return json({
        items: requests.filter(
          (r) => Number(r.turn_id) <= turns && !answers.has(r.request_id),
        ),
        answerable: true,
      });
    if (method === "POST" && path.endsWith("/answers")) {
      const { request_id } = body as { request_id: string };
      expect(request.headers.get("idempotency-key")).toBe(
        `answer:${request_id}`,
      );
      const stored = answers.get(request_id);
      if (stored && JSON.stringify(stored) !== JSON.stringify(body))
        return apiError(conflictStatus, conflictCode);
      answers.set(request_id, body);
      return json(
        { receipt_id: `answer-${request_id}`, receipt_status: "accepted" },
        202,
      );
    }
    if (path.startsWith("/v1/receipts/"))
      return json({
        status: "succeeded",
        operation: path.includes("answer-") ? "answer" : "close",
        result: null,
      });
    const turn = path.match(/\/turns\/(\d+)$/)?.[1];
    if (turn) {
      const ended = answers.has(`req-${turn}`);
      const status = !ended
        ? "running"
        : turn === "3"
          ? options.lastTurn
          : "completed";
      return json({
        turn_id: turn,
        status,
        ended_at: ended ? "2026-10-29T00:01:00Z" : null,
      });
    }
    if (path.endsWith("/close"))
      return json(
        { receipt_id: "close-receipt", receipt_status: "accepted" },
        202,
      );
    if (path === `/v1/sessions/${SESSION}`)
      return json({
        revision: 4,
        admission_state: "active",
        status: "needs_input",
      });
    return apiError(404, "NOT_FOUND");
  };
  return { route, answers };
}

test("answers a question, denies one write, allows the next once", async () => {
  const fake = fakeQuestions({ lastTurn: "completed" });
  const { exit, stdout, stderr } = await runSample(SAMPLE, fake.route);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  for (const line of [
    'question req-1: "Which environment should the report cover?" -> staging',
    "permission req-2: deny Write /workspace/notes.txt",
    "open request req-3: permission Write /workspace/notes.txt",
    "permission req-3: allow Write /workspace/notes.txt",
    "answer receipt: answer succeeded",
    "second answer: 409 IDEMPOTENCY_CONFLICT",
    "turn 3: completed",
    "still open: 0",
    "close: receipt succeeded",
  ])
    expect(stdout).toContain(line);
  expect(Object.fromEntries(fake.answers)).toEqual({
    "req-1": {
      request_id: "req-1",
      kind: "question",
      answers: [{ question_id: "q-1", selected_option_ids: ["opt-staging"] }],
    },
    "req-2": {
      request_id: "req-2",
      kind: "permission",
      action: "deny",
      reason: "This run only reads; do not write files",
    },
    "req-3": { request_id: "req-3", kind: "permission", action: "allow" },
  });
});

test("fails when a turn does not complete", async () => {
  const { exit, stderr } = await runSample(
    SAMPLE,
    fakeQuestions({ lastTurn: "failed" }).route,
  );
  expect(exit).toBe(1);
  expect(stderr).toContain("a turn did not complete");
});

test("fails when a second answer is refused for another reason", async () => {
  const { exit, stdout, stderr } = await runSample(
    SAMPLE,
    fakeQuestions({ lastTurn: "completed", conflict: [403, "FORBIDDEN"] })
      .route,
  );
  expect(exit).toBe(1);
  expect(stdout).not.toContain("second answer:");
  expect(stderr).toContain("was not refused as a conflict");
});
