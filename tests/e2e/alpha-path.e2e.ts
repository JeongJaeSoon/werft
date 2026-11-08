import { describe, expect, test } from "bun:test";
import {
  Api,
  bash,
  type ErrorBody,
  e2eEnv,
  poll,
  scripted,
  type Turn,
} from "./client.ts";

/**
 * The alpha path against a stack tests/e2e/run.sh started: the
 * images this checkout builds, a real Claude Code inside each worker, the
 * compose fake Messages API playing each prompt's script. docs/quickstart.md
 * walks the same steps by hand with curl.
 */
const api = new Api(e2eEnv());
const TIMEOUT = 600_000;

/**
 * Settles a turn that must not ask anything: a read-only command runs
 * without a permission request, and docs/quickstart.md answers none there.
 */
async function settleUnasked(sessionId: string, turnId: string): Promise<Turn> {
  return poll(`turn ${turnId} of ${sessionId}`, 180_000, async () => {
    const turn = await api.turn(sessionId, turnId);
    if (!["queued", "running", "needs_input"].includes(turn.status)) {
      return turn;
    }
    const asked = (await api.pending(sessionId)).filter(
      (request) => request.turn_id === turnId,
    );
    if (asked.length > 0) {
      throw new Error(`turn ${turnId} asked: ${JSON.stringify(asked)}`);
    }
    return null;
  });
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

async function revision(sessionId: string): Promise<number> {
  return (await api.session(sessionId)).revision;
}

describe("alpha path over public HTTP", () => {
  test(
    "create → events → pending → answer → message → interrupt → pause → resume → terminate → recovery → resume",
    async () => {
      // 1. create: the first turn writes a file through `tee`, which asks
      // permission. A redirect into the workspace would not: the platform
      // pre-approves writes under the session workspace.
      const created = await api.createSession(
        scripted("q1", [bash("echo alpha | tee hello.txt")], "wrote hello.txt"),
      );
      expect(created.status).toBe(201);
      const sessionId = created.body.session_id;
      expect(created.body).toMatchObject({ turn_id: "1", status: "queued" });

      // 2. events: the permission question arrives on the stream.
      const events = await api.events(
        sessionId,
        (event) => event.event === "question",
      );
      const question = events.at(-1);
      expect(question?.data.turn_id).toBe("1");

      // 3. pending-requests: the same request, typed.
      const [request] = await api.pendingUntil(sessionId, 1);
      expect(request).toMatchObject({
        kind: "permission",
        tool: "Bash",
        turn_id: "1",
        request_id: question?.data.data.request_id,
      });
      expect((await api.session(sessionId)).status).toBe("needs_input");

      // 4. answers: allow, and the turn completes.
      const answer = await api.allow(sessionId, must(request).request_id);
      expect((await api.settledTurn(sessionId, "1")).status).toBe("completed");
      expect(
        (
          await api.receiptUntil(
            answer.receipt_id,
            (r) => r.status !== "accepted",
          )
        ).status,
      ).toBe("succeeded");

      // 5. messages: a follow-up turn on the same engine session.
      const second = await api.send(
        sessionId,
        scripted("q2", [], "second turn"),
      );
      expect(second.turn_id).toBe("2");
      expect((await api.settledTurn(sessionId, "2")).status).toBe("completed");

      // 6. interrupt: a turn stuck in a slow model call stops on request.
      const slow = await api.send(
        sessionId,
        scripted("q3", [], "too late", 300_000),
      );
      await api.sessionUntil(
        sessionId,
        "runs turn 3",
        (s) => s.current_turn_id === slow.turn_id && s.status === "running",
      );
      await api.modelCallSeen("q3", 0);
      const interrupt = await api.control(sessionId, "interrupt", {
        target_turn_id: slow.turn_id,
      });
      expect(interrupt.status).toBe(202);
      const interruptReceipt = await api.receiptUntil(
        (interrupt.body as { receipt_id: string }).receipt_id,
        (r) => r.status !== "accepted",
      );
      expect(interruptReceipt.status).toBe("succeeded");
      expect((await api.settledTurn(sessionId, slow.turn_id)).status).toBe(
        "interrupted",
      );

      // 7. pause: the worker drains, checkpoints and goes away. An
      // interrupted turn leaves the session `stopped`, not `idle`; its
      // worker stays for the next message.
      await api.sessionUntil(
        sessionId,
        "is stopped",
        (s) => s.status === "stopped",
      );
      const pause = await api.control(sessionId, "pause", {
        expected_revision: await revision(sessionId),
        reason: "e2e",
      });
      expect(pause.status).toBe(202);
      await api.sessionUntil(
        sessionId,
        "is paused",
        (s) => s.admission_state === "paused",
      );
      const refused = await api.request<ErrorBody>(
        "POST",
        `/v1/sessions/${sessionId}/messages`,
        { message: "while paused" },
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("SESSION_PAUSED");

      // 8. resume: a new worker restores the checkpoint, workspace included.
      const resume = await api.control(sessionId, "resume", {
        expected_revision: await revision(sessionId),
      });
      expect(resume.status).toBe(202);
      await api.sessionUntil(
        sessionId,
        "is active again",
        (s) => s.admission_state === "active",
      );
      const afterResume = await api.send(
        sessionId,
        scripted("q4", [bash("cat hello.txt")], "restored"),
      );
      expect((await settleUnasked(sessionId, afterResume.turn_id)).status).toBe(
        "completed",
      );
      const catResult = (
        await api.events(
          sessionId,
          (event) =>
            event.event === "tool_result" &&
            event.data.turn_id === afterResume.turn_id,
        )
      ).at(-1);
      expect(JSON.stringify(catResult?.data.data)).toContain("alpha");

      // 9. terminate mid-turn → recovery decision → resume.
      const doomed = await api.send(
        sessionId,
        scripted("q5", [], "never", 300_000),
      );
      await api.sessionUntil(
        sessionId,
        "runs the doomed turn",
        (s) => s.current_turn_id === doomed.turn_id && s.status === "running",
      );
      await api.modelCallSeen("q5", 0);
      const terminate = await api.control(sessionId, "terminate", {
        expected_revision: await revision(sessionId),
        reason: "e2e",
      });
      expect(terminate.status).toBe(202);
      const stopped = await api.sessionUntil(
        sessionId,
        "needs a recovery decision",
        (s) => s.admission_state === "recovery_required",
      );
      expect(stopped.status).toBe("failed");
      expect((await api.turn(sessionId, doomed.turn_id)).status).toBe(
        "outcome_unknown",
      );
      const decision = await api.control(sessionId, "recovery-decisions", {
        decision: "abandon",
        expected_revision: stopped.revision,
        reason: "e2e: the slow call had no effect",
        target_turn_id: doomed.turn_id,
      });
      expect(decision.status).toBe(202);
      const decided = await api.receiptUntil(
        (decision.body as { receipt_id: string }).receipt_id,
        (r) => r.status !== "accepted",
      );
      expect(decided).toMatchObject({
        status: "succeeded",
        result: { resulting_admission_state: "stopped", resumable: true },
      });
      expect((await api.turn(sessionId, doomed.turn_id)).status).toBe(
        "cancelled",
      );
      const again = await api.control(sessionId, "resume", {
        expected_revision: await revision(sessionId),
      });
      expect(again.status).toBe(202);
      await api.sessionUntil(
        sessionId,
        "is active after recovery",
        (s) => s.admission_state === "active",
      );
      const last = await api.send(
        sessionId,
        scripted("q6", [bash("cat hello.txt")], "still here"),
      );
      expect((await settleUnasked(sessionId, last.turn_id)).status).toBe(
        "completed",
      );
    },
    TIMEOUT,
  );
});

describe("recovery close over public HTTP", () => {
  test(
    "terminate → confirm_completed refused without a covering checkpoint → close → resume is 409 SESSION_CLOSED",
    async () => {
      const created = await api.createSession(
        scripted("x1", [], "never", 300_000),
      );
      const sessionId = created.body.session_id;
      await api.sessionUntil(
        sessionId,
        "runs turn 1",
        (s) => s.current_turn_id === "1" && s.status === "running",
      );
      await api.modelCallSeen("x1", 0);
      const terminate = await api.control(sessionId, "terminate", {
        expected_revision: await revision(sessionId),
        reason: "e2e",
      });
      expect(terminate.status).toBe(202);
      const stopped = await api.sessionUntil(
        sessionId,
        "needs a recovery decision",
        (s) => s.admission_state === "recovery_required",
      );
      expect((await api.turn(sessionId, "1")).status).toBe("outcome_unknown");

      // Turn 1 never finished, so no checkpoint reaches it.
      const confirm = await api.control(sessionId, "recovery-decisions", {
        decision: "confirm_completed",
        expected_revision: stopped.revision,
        reason: "e2e: claims the unfinished turn completed",
        target_turn_id: "1",
        evidence_ref: "e2e://none",
      });
      expect(confirm.status).toBe(409);
      expect((confirm.body as ErrorBody).error.code).toBe(
        "CHECKPOINT_UNAVAILABLE",
      );
      expect((await api.turn(sessionId, "1")).status).toBe("outcome_unknown");

      const close = await api.control(sessionId, "recovery-decisions", {
        decision: "close",
        expected_revision: stopped.revision,
        reason: "e2e: give the session up",
      });
      expect(close.status).toBe(202);
      const closed = await api.receiptUntil(
        (close.body as { receipt_id: string }).receipt_id,
        (r) => r.status !== "accepted",
      );
      expect(closed).toMatchObject({
        status: "succeeded",
        result: { resulting_admission_state: "closed", resumable: false },
      });
      expect((await api.session(sessionId)).admission_state).toBe("closed");

      const resume = await api.control(sessionId, "resume", {
        expected_revision: await revision(sessionId),
      });
      expect(resume.status).toBe(409);
      expect((resume.body as ErrorBody).error.code).toBe("SESSION_CLOSED");
    },
    TIMEOUT,
  );
});

describe("default commit identity", () => {
  test(
    "Claude commits in a new session as the identity the site page operate/images-and-supply-chain names",
    async () => {
      const created = await api.createSession(
        scripted(
          "g1",
          [
            bash(
              "git commit -q --allow-empty -m e2e-identity && git log -1 --format='%an <%ae>|%cn <%ce>'",
            ),
          ],
          "committed",
        ),
      );
      const sessionId = created.body.session_id;
      const [request] = await api.pendingUntil(sessionId, 1);
      await api.allow(sessionId, must(request).request_id);
      expect((await api.settledTurn(sessionId, "1")).status).toBe("completed");
      const result = (
        await api.events(
          sessionId,
          (event) =>
            event.event === "tool_result" && event.data.turn_id === "1",
        )
      ).at(-1);
      const identity = "Werft <noreply@werft.invalid>";
      expect(JSON.stringify(result?.data.data)).toContain(
        `${identity}|${identity}`,
      );
    },
    TIMEOUT,
  );
});

describe("concurrency regressions", () => {
  test(
    "a retried create is one session; the same key with another body is refused",
    async () => {
      const key = crypto.randomUUID();
      const message = scripted("c1", [], "created once");
      const [first, retry] = await Promise.all([
        api.createSession(message, key),
        api.createSession(message, key),
      ]);
      expect([first.status, retry.status]).toEqual([201, 201]);
      expect(retry.body.session_id).toBe(first.body.session_id);
      const conflict = await api.createSession(
        scripted("c1-other", [], "other"),
        key,
      );
      expect(conflict.status).toBe(409);
      expect((conflict.body as unknown as ErrorBody).error.code).toBe(
        "IDEMPOTENCY_CONFLICT",
      );
      expect((await api.settledTurn(first.body.session_id, "1")).status).toBe(
        "completed",
      );
    },
    TIMEOUT,
  );

  test(
    "three concurrent messages to one session become three turns, run in order",
    async () => {
      const created = await api.createSession(scripted("m0", [], "ready"));
      const sessionId = created.body.session_id;
      await api.settledTurn(sessionId, "1");
      const sent = await Promise.all(
        [1, 2, 3].map((n) =>
          api.send(sessionId, scripted(`m${n}`, [], `reply ${n}`)),
        ),
      );
      const ids = sent.map((turn) => Number(turn.turn_id)).sort();
      expect(ids).toEqual([2, 3, 4]);
      const settled = [];
      for (const id of ids) {
        settled.push(await api.settledTurn(sessionId, String(id)));
      }
      expect(settled.map((turn) => turn.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
      // In order: each turn starts only after the one before it ended.
      for (let index = 1; index < settled.length; index++) {
        const before = Date.parse(String(must(settled[index - 1]).ended_at));
        const after = Date.parse(String(must(settled[index]).started_at));
        expect(after).toBeGreaterThanOrEqual(before);
      }
    },
    TIMEOUT,
  );

  test(
    "approvals answered in reverse order each reach their own request",
    async () => {
      const sessions = await Promise.all(
        ["a1", "a2"].map(async (id) => {
          const created = await api.createSession(
            scripted(id, [bash(`echo ${id} | tee ${id}.txt`)], `${id} done`),
          );
          return created.body.session_id;
        }),
      );
      const requests = await Promise.all(
        sessions.map(async (id) => must((await api.pendingUntil(id, 1))[0])),
      );
      // Another session's request id is not answerable here.
      const crossed = await api.request<ErrorBody>(
        "POST",
        `/v1/sessions/${sessions[0]}/answers`,
        {
          request_id: must(requests[1]).request_id,
          kind: "permission",
          action: "allow",
        },
      );
      expect(crossed.status).toBeGreaterThanOrEqual(400);
      expect(crossed.status).toBeLessThan(500);
      for (const index of [1, 0]) {
        await api.allow(
          must(sessions[index]),
          must(requests[index]).request_id,
        );
      }
      for (const id of sessions) {
        expect((await api.settledTurn(id, "1")).status).toBe("completed");
      }
    },
    TIMEOUT,
  );

  test(
    "two requests of one turn are each answered by their own id",
    async () => {
      // Claude Code asks for one tool at a time, even for tool calls the
      // model sent together, so one turn never holds two open requests; what
      // can go wrong is an answer landing on the next one.
      const created = await api.createSession(
        scripted(
          "t1",
          [bash("echo one | tee one.txt"), bash("echo two | tee two.txt")],
          "both written",
        ),
      );
      const sessionId = created.body.session_id;
      const [first] = await api.pendingUntil(sessionId, 1);
      await api.allow(sessionId, must(first).request_id);
      const second = await poll("the second request", 180_000, async () => {
        const items = await api.pending(sessionId);
        const next = items.find(
          (item) => item.request_id !== must(first).request_id,
        );
        return next ?? null;
      });
      const again = await api.request<ErrorBody>(
        "POST",
        `/v1/sessions/${sessionId}/answers`,
        {
          request_id: must(first).request_id,
          kind: "permission",
          action: "allow",
        },
      );
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("REQUEST_EXPIRED");
      await api.allow(sessionId, second.request_id);
      expect((await api.settledTurn(sessionId, "1")).status).toBe("completed");
    },
    TIMEOUT,
  );

  test(
    "an interrupt racing the next message stops only its target",
    async () => {
      const created = await api.createSession(
        scripted("r1", [], "slow", 300_000),
      );
      const sessionId = created.body.session_id;
      await api.sessionUntil(
        sessionId,
        "runs turn 1",
        (s) => s.current_turn_id === "1" && s.status === "running",
      );
      await api.modelCallSeen("r1", 0);
      const [interrupt, next] = await Promise.all([
        api.control(sessionId, "interrupt", { target_turn_id: "1" }),
        api.send(sessionId, scripted("r2", [], "next one")),
      ]);
      expect(interrupt.status).toBe(202);
      expect((await api.settledTurn(sessionId, "1")).status).toBe(
        "interrupted",
      );
      expect((await api.settledTurn(sessionId, next.turn_id)).status).toBe(
        "completed",
      );
    },
    TIMEOUT,
  );

  test(
    "a Bash tool in the worker finds no provider token anywhere, and the route refuses it without one",
    async () => {
      // Brackets keep each pattern from matching the probe's own command.
      const probe = [
        "tok='we[p]_[A-Za-z0-9_-]\\{20,\\}'",
        "var='^ANTHROPIC_API_KE[Y]='",
        'env_hits=$(env | grep -c -e "$tok" -e "$var")',
        "readable=0; hits=0; engine=0",
        "for f in /proc/[0-9]*/environ; do",
        '  e=$(tr "\\0" "\\n" < "$f" 2>/dev/null) || continue',
        '  [ -n "$e" ] || continue',
        "  readable=$((readable+1))",
        '  printf "%s\\n" "$e" | grep -q -e "$tok" -e "$var" && hits=$((hits+1))',
        '  printf "%s\\n" "$e" | grep -q \'^CLAUDE_CODE_API_KEY_FILE_DESCRIPTO[R]=\' && engine=$((engine+1))',
        "done",
        `direct=$(bun -e 'const r = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers: { "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: "{}" }); console.log(r.status)' 2>&1)`,
        'echo "probe env_hits=$env_hits readable=$readable hits=$hits engine=$engine direct_status=$direct"',
      ].join("\n");
      const created = await api.createSession(
        scripted("k1", [bash(probe)], "probed"),
      );
      const sessionId = created.body.session_id;
      const turn = await poll("the probe turn", 180_000, async () => {
        for (const request of await api.pending(sessionId)) {
          await api.allow(sessionId, request.request_id);
        }
        const current = await api.turn(sessionId, "1");
        return ["queued", "running", "needs_input"].includes(current.status)
          ? null
          : current;
      });
      expect(turn.status).toBe("completed");
      const result = (
        await api.events(
          sessionId,
          (event) =>
            event.event === "tool_result" && event.data.turn_id === "1",
        )
      ).at(-1);
      const printed = JSON.stringify(result?.data.data);
      const report =
        /probe env_hits=(\d+) readable=(\d+) hits=(\d+) engine=(\d+) direct_status=(\S+?)\b/.exec(
          printed,
        );
      if (report === null) throw new Error(`no probe output in ${printed}`);
      // The ticket's acceptance evidence, kept in the CI log.
      console.log(report[0]);
      const [, envHits, readable, hits, engine, direct] = report;
      expect({ envHits, hits, direct }).toEqual({
        envHits: "0",
        hits: "0",
        direct: "401",
      });
      // The probe read the engine's environ among others, so no hit is a
      // finding and not a blind spot.
      expect(Number(engine)).toBeGreaterThanOrEqual(1);
      expect(Number(readable)).toBeGreaterThan(Number(engine));
    },
    TIMEOUT,
  );
});
