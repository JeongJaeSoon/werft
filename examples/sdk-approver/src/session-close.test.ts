import { expect, test } from "bun:test";

test.each(["success", "turn-failed", "close-failed"])(
  "the CLI uses an agent release and human approver: %s",
  async (scenario) => {
    let answered = false;
    let closed = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const authorization = request.headers.get("authorization");
        const json = (body: unknown, status = 200) =>
          Response.json(body, { status });
        if (path === "/v1/sessions" && request.method === "POST") {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body.agent_release_id).toBe("sha256:sample-release");
          expect(authorization).toBe("Bearer sample-agent");
          expect(body.profile_id).toBeUndefined();
          expect(body.repository_id).toBeUndefined();
          return json(
            { session_id: "sample-session", turn_id: "1", status: "queued" },
            201,
          );
        }
        if (path.endsWith("/events")) {
          return new Response("", {
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (path.includes("/turns/")) {
          const turn_id = path.split("/").at(-1);
          const ended = turn_id === "1" || answered;
          return json({
            turn_id,
            status: ended
              ? scenario === "turn-failed"
                ? "failed"
                : "completed"
              : "running",
            ended_at: ended ? "2026-10-28T00:00:00Z" : null,
          });
        }
        if (path.endsWith("/pending-requests")) {
          return json({
            items: [
              {
                request_id: "sample-request",
                kind: "permission",
                tool: "Bash",
                input: { command: "echo alpha | tee hello.txt" },
                created_at: "2026-10-28T00:00:00Z",
              },
            ],
          });
        }
        if (path.endsWith("/answers")) {
          expect(authorization).toBe("Bearer sample-human");
          expect(await request.json()).toMatchObject({
            request_id: "sample-request",
            kind: "permission",
            action: "allow",
          });
          answered = true;
          return json(
            { receipt_id: "answer-receipt", receipt_status: "accepted" },
            202,
          );
        }
        if (path.endsWith("/messages")) {
          if (closed)
            return json(
              {
                error: {
                  code: "SESSION_CLOSED",
                  message: "closed",
                  retryable: false,
                },
              },
              409,
            );
          return json({ turn_id: "2", status: "queued" }, 202);
        }
        if (path.endsWith("/close")) {
          closed = true;
          return json(
            { receipt_id: "close-receipt", receipt_status: "accepted" },
            202,
          );
        }
        if (path === "/v1/receipts/close-receipt") {
          expect(authorization).toBe("Bearer sample-agent");
          return json({
            status: scenario === "close-failed" ? "failed" : "succeeded",
            operation: "close",
            result: {
              checkpoint_revision: 1,
              cancelled_turn_count: 0,
              resulting_admission_state: "closed",
            },
          });
        }
        return json({
          revision: 1,
          admission_state: closed ? "closed" : "active",
          status: closed ? "stopped" : "running",
        });
      },
    });
    try {
      const child = Bun.spawn(
        [process.execPath, `${import.meta.dir}/session-close.ts`],
        {
          env: {
            PATH: process.env.PATH,
            WERFT_BASE_URL: server.url.href,
            WERFT_API_KEY: "sample-agent",
            WERFT_APPROVER_API_KEY: "sample-human",
            WERFT_AGENT_RELEASE_ID: "sha256:sample-release",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (scenario === "success") {
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        expect(answered).toBe(true);
        expect(stdout).toContain("turn 2: completed");
        expect(stdout).toContain("409 SESSION_CLOSED");
      } else {
        expect(exit).toBe(1);
        expect(stderr).toContain(
          scenario === "turn-failed"
            ? "turn 1 did not complete"
            : "close did not succeed",
        );
      }
    } finally {
      await server.stop(true);
    }
  },
  10_000,
);
