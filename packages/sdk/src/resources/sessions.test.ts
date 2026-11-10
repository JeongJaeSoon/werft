import { describe, expect, test } from "bun:test";
import type {
  AdmissionState,
  ApiErrorCode,
  PauseParams,
  PushRequest,
  SessionEvent,
  TurnStatus,
} from "../index.ts";
import { apiError, fakeApi, json, werft } from "../testing/fake-api.ts";

describe("open unions", () => {
  test("response enums take values a newer server sends; request enums stay closed", async () => {
    const status: TurnStatus = "brand_new_status";
    const admission: AdmissionState = "brand_new_state";
    const code: ApiErrorCode = "BRAND_NEW_CODE";
    const state: PushRequest["state"] = "brand_new_push_state";
    // @ts-expect-error: a request body is checked by the server; unknown fields are refused.
    const params: PauseParams = { expected_revision: 1, extra: true };
    expect([status, admission, code, state, params]).toHaveLength(5);

    const api = fakeApi(() =>
      json(200, { id: "s1", admission_state: "brand_new_state" }),
    );
    const session = await werft(api.fetch).sessions.get("s1");
    expect(session.admission_state).toBe("brand_new_state");
  });

  test("an event still narrows on its kind", () => {
    const event = {
      id: "e1",
      turn_id: null,
      attempt_id: null,
      occurred_at: "now",
      kind: "result",
      payload: {},
    } as unknown as SessionEvent;
    if (event.kind === "result") expect(event.kind).toBe("result");
  });
});

describe("requests carry the generated shape", () => {
  test("every keyed command sends an Idempotency-Key; openPullRequest does not", async () => {
    const api = fakeApi(() =>
      json(202, { receipt_id: "r", receipt_status: "accepted" }),
    );
    const client = werft(api.fetch);
    await client.sessions.create({
      agent_release_id: "sha256:r",
      repository_id: "r",
      message: "m",
    });
    await client.sessions.messages.send("s1", { message: "m" });
    await client.sessions.interrupt("s1", { target_turn_id: "t1" });
    await client.sessions.pause("s1", { expected_revision: 1 });
    await client.sessions.resume("s1", { expected_revision: 2 });
    await client.sessions.terminate("s1", { expected_revision: 3 });
    await client.sessions.recoveryDecisions.create("s1", {
      decision: "start_fresh",
      expected_revision: 4,
      reason: "r",
    });
    await client.sessions.pushRequests.create("s1");
    await client.sessions.pushRequests.approve("s1", "pr1", {
      git_commit: "abc",
    });
    await client.sessions.pushRequests.reject("s1", "pr1", {
      git_commit: "abc",
      reason: "no",
    });
    await client.sessions.pushRequests.openPullRequest("s1", "pr1");
    const sent = api.seen.map((r) => [
      r.path,
      r.headers.has("idempotency-key"),
    ]);
    expect(sent).toEqual([
      ["/v1/sessions", true],
      ["/v1/sessions/s1/messages", true],
      ["/v1/sessions/s1/interrupt", true],
      ["/v1/sessions/s1/pause", true],
      ["/v1/sessions/s1/resume", true],
      ["/v1/sessions/s1/terminate", true],
      ["/v1/sessions/s1/recovery-decisions", true],
      ["/v1/sessions/s1/push-requests", true],
      ["/v1/sessions/s1/push-requests/pr1/approve", true],
      ["/v1/sessions/s1/push-requests/pr1/reject", true],
      ["/v1/sessions/s1/push-requests/pr1/pull-request", false],
    ]);
    expect(api.seen[3]?.body).toEqual({ expected_revision: 1 });
    expect(api.seen[7]?.body).toEqual({});
    expect(api.seen[9]?.body).toEqual({ git_commit: "abc", reason: "no" });
  });

  test("openPullRequest is not retried after a lost response", async () => {
    const api = fakeApi(() => {
      throw new TypeError("socket hang up");
    });
    const error = await werft(api.fetch)
      .sessions.pushRequests.openPullRequest("s1", "pr1")
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("NETWORK_ERROR");
    expect(api.seen).toHaveLength(1);
  });

  test("an explicit answer key wins over answer:<request_id>", async () => {
    const api = fakeApi(() =>
      json(202, { receipt_id: "r", receipt_status: "accepted" }),
    );
    await werft(api.fetch).sessions.requests.answer(
      "s1",
      { request_id: "q1", kind: "permission", action: "allow" },
      { idempotencyKey: "after-restart" },
    );
    expect(api.seen[0]?.headers.get("idempotency-key")).toBe("after-restart");
  });
});

describe("pagination", () => {
  test("await gives the first page, nextPage the next, null after the last", async () => {
    const api = fakeApi((_, url) =>
      url.searchParams.get("cursor") === "c2"
        ? json(200, { items: [{ id: "s3" }], next_cursor: null })
        : json(200, { items: [{ id: "s1" }, { id: "s2" }], next_cursor: "c2" }),
    );
    const client = werft(api.fetch);
    const first = await client.sessions.list({ limit: 2 });
    expect(first.items.map((s) => s.id)).toEqual(["s1", "s2"]);
    const second = await first.nextPage();
    expect(second?.items.map((s) => s.id)).toEqual(["s3"]);
    expect(await second?.nextPage()).toBeNull();
    expect(api.seen[0]?.url).toContain("limit=2");
  });

  test("nextPage keeps the first call's options; the ones it is given win", async () => {
    const api = fakeApi((_, url) =>
      json(200, {
        items: [],
        next_cursor: url.searchParams.has("cursor") ? "c3" : "c2",
      }),
    );
    const controller = new AbortController();
    const first = await werft(api.fetch).sessions.list(undefined, {
      signal: controller.signal,
      headers: { "x-trace": "one" },
    });
    const second = await first.nextPage({ headers: { "x-trace": "two" } });
    expect(api.seen.map((r) => r.headers.get("x-trace"))).toEqual([
      "one",
      "two",
    ]);
    controller.abort();
    await expect(second?.nextPage()).rejects.toThrow(/aborted/);
    expect(api.seen).toHaveLength(2);
  });

  test("for await walks every item of every page", async () => {
    const api = fakeApi((_, url) =>
      url.searchParams.get("cursor") === "c2"
        ? json(200, { items: [{ turn_id: "t3" }], next_cursor: null })
        : json(200, {
            items: [{ turn_id: "t1" }, { turn_id: "t2" }],
            next_cursor: "c2",
          }),
    );
    const ids: string[] = [];
    for await (const turn of werft(api.fetch).sessions.turns.list("s1"))
      ids.push(turn.turn_id);
    expect(ids).toEqual(["t1", "t2", "t3"]);
  });
});

describe("list endpoints without pages return arrays", () => {
  test("pending requests and push requests", async () => {
    const api = fakeApi(() => json(200, { items: [{ request_id: "q1" }] }));
    const client = werft(api.fetch);
    expect(await client.sessions.requests.list("s1")).toHaveLength(1);
    expect(await client.sessions.pushRequests.list("s1")).toHaveLength(1);
  });

  test("a 404 from a list is an error, not an empty list", async () => {
    const api = fakeApi(() => apiError(404, "NOT_FOUND"));
    await expect(werft(api.fetch).sessions.requests.list("s1")).rejects.toThrow(
      /NOT_FOUND/,
    );
  });
});
