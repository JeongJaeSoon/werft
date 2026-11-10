import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  PENDING_SETTLEMENTS_MAX,
  type PendingControlRequest,
  type PendingControlResponse,
  type PendingQuestion,
  type PostSessionAnswerRequest,
  pendingControlRequestSchema,
  type RegisterPendingRequest,
  type RegisterPendingResponse,
  type SessionEventPayload,
  type WorkerScope,
} from "@werft-ai/contracts";
import {
  type AnswerResult,
  type ApprovalDecisionPayload,
  type ApprovalRequested,
  approvalInputHash,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";

import {
  PendingRequestRegistry,
  type PendingRequestsOptions,
} from "./pending-requests.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";

const scope: WorkerScope = {
  session_id: "11111111-1111-4111-8111-111111111111",
  turn_id: "1",
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};

async function waitFor(check: () => boolean, what: string) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
}

function registry(
  options: Partial<PendingRequestsOptions> & { timeoutMs?: number } = {},
) {
  const gateway = new FakeWorkerGateway();
  // What the gateway would have written to the stream: a question event for
  // each registration that landed.
  const published: SessionEventPayload[] = [];
  const lost: unknown[] = [];
  const target = options.gateway ?? gateway;
  const instance = new PendingRequestRegistry({
    eventsStored: async () => {},
    scope: () => scope,
    timeoutMs: 30_000,
    pollIntervalMs: 1,
    onOwnershipLost: (error) => lost.push(error),
    ...options,
    gateway: {
      async registerPending(request) {
        const response = await target.registerPending(request);
        // Once per row: a replay writes nothing, as with the real gateway.
        const seen = published.some(
          (event) =>
            event.event === "question" &&
            event.data.request_id === request.request_id,
        );
        if (request.announce !== undefined && !seen) {
          published.push({
            event: "question",
            data: {
              request_id: request.request_id,
              tool_use_id: request.announce.tool_use_id,
              kind: request.request.kind,
              tool: request.announce.tool,
              input:
                request.request.kind === "permission"
                  ? request.request.input
                  : { questions: request.request.questions },
            },
          });
        }
        return response;
      },
      pendingControl: (request) => target.pendingControl(request),
    },
  });
  // The id the worker minted for the callback the engine raised as this
  // tool use, once its question event is out.
  const idFor = async (sdkRequestId: string) => {
    const toolUseId = `toolu_${sdkRequestId}`;
    const find = () =>
      published.find(
        (event) =>
          event.event === "question" && event.data.tool_use_id === toolUseId,
      );
    await waitFor(() => find() !== undefined, `the ${toolUseId} event`);
    const event = find();
    return event?.event === "question" ? event.data.request_id : "";
  };
  return {
    gateway,
    lost,
    published,
    registry: instance,
    idFor,
    /** `result` is what the run says of the answer it is handed. */
    ask(
      request: ApprovalRequested,
      result: AnswerResult | Error = "applied",
    ): Promise<ApprovalDecisionPayload> {
      return new Promise((resolve) =>
        instance.request(request, async (decision) => {
          resolve(decision);
          if (result instanceof Error) throw result;
          return result;
        }),
      );
    },
    // Answers the callback the engine knows as `request_id`.
    async answer(answer: PostSessionAnswerRequest) {
      const requestId = await idFor(answer.request_id);
      gateway.answer({ ...answer, request_id: requestId });
      return requestId;
    },
  };
}

function approval(
  requestId: string,
  name: string,
  input: Record<string, unknown>,
  display: Record<string, unknown> = input,
): ApprovalRequested {
  return {
    localId: `local_${requestId}`,
    toolCallId: `toolu_${requestId}`,
    tool: { name, input },
    inputHash: approvalInputHash(name, input),
    askedAt: performance.now(),
    kind: "permission",
    display,
  };
}

function permission(requestId: string, command = "ls"): ApprovalRequested {
  return approval(requestId, "Bash", { command });
}

const ENVIRONMENT: PendingQuestion = {
  question_id: "q0",
  prompt: "Which environment?",
  options: [
    { option_id: "q0o0", label: "staging" },
    { option_id: "q0o1", label: "production" },
  ],
  multi_select: false,
  allow_free_text: true,
};

// No engine's question tool: the registry reads only the run's questions.
function question(
  requestId: string,
  questions: PendingQuestion[] = [ENVIRONMENT],
): ApprovalRequested {
  const input = { ask: "environment" };
  return {
    localId: `local_${requestId}`,
    toolCallId: `toolu_${requestId}`,
    tool: { name: "ask_human", input },
    inputHash: approvalInputHash("ask_human", input),
    askedAt: performance.now(),
    kind: "question",
    questions,
  };
}

describe("PendingRequestRegistry", () => {
  test("registers before publishing, under an id of its own and the raw arguments' hash", async () => {
    const harness = registry();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const request = approval(
      "req-allow",
      "Bash",
      { command: `curl -H 'x-api-key: ${secret}'` },
      { command: "curl -H 'x-api-key: [REDACTED]'" },
    );
    const decision = harness.ask(request);
    const requestId = await harness.idFor("req-allow");

    expect(requestId).toMatch(/^req_[0-9a-f-]{36}$/);
    const [registration] = harness.gateway.registered();
    expect(registration?.request_id).toBe(requestId);
    expect(registration?.turn_id).toBe("1");
    expect(registration?.input_hash).toBe(
      createHash("sha256")
        .update(canonicalJson({ tool: "Bash", input: request.tool.input }))
        .digest("hex"),
    );
    // What clients see is the run's redacted copy; the hash is not.
    expect(registration?.request).toEqual({
      kind: "permission",
      tool: "Bash",
      input: { command: "curl -H 'x-api-key: [REDACTED]'" },
    });
    // The gateway writes the question event, so it is told what that event
    // needs beyond the request.
    expect(registration?.announce).toEqual({
      tool_use_id: "toolu_req-allow",
      tool: "Bash",
    });
    expect(harness.gateway.calls.indexOf("registerPending")).toBeGreaterThan(
      -1,
    );
    const event = harness.published[0];
    expect(event?.event === "question" ? event.data : null).toMatchObject({
      request_id: requestId,
      kind: "permission",
      tool: "Bash",
      tool_use_id: "toolu_req-allow",
    });
    expect(harness.registry.outstanding).toBe(1);

    await harness.answer({
      request_id: "req-allow",
      kind: "permission",
      decision: "allow",
    });
    expect(await decision).toEqual({
      kind: "selected",
      optionKind: "allow_once",
    });
    expect(harness.registry.outstanding).toBe(0);
    await waitFor(() => harness.gateway.settled.length === 1, "settlement");
    expect(harness.gateway.settled).toEqual([
      { request_id: requestId, outcome: "answered", answer_result: "applied" },
    ]);
  });

  test("shows the file a permission request writes", async () => {
    const harness = registry();
    const input = { file_path: "/workspace/src/a.ts", content: "x" };
    void harness.ask(approval("req-write", "Write", input));
    await harness.idFor("req-write");

    const [registration] = harness.gateway.registered();
    expect(registration?.request).toEqual({
      kind: "permission",
      tool: "Write",
      input,
    });
    const event = harness.published[0];
    expect(event?.event === "question" ? event.data.input : null).toEqual(
      input,
    );
  });

  test("registers only once the events before the callback are stored", async () => {
    let stored: (() => void) | undefined;
    const harness = registry({
      eventsStored: () =>
        new Promise<void>((resolve) => {
          stored = resolve;
        }),
    });
    const decision = harness.ask(permission("req-ordered"));
    await waitFor(() => stored !== undefined, "the barrier");
    await Bun.sleep(5);
    // The gateway writes the question as it registers, so registering now
    // could put it ahead of the tool call still in the publisher.
    expect(harness.gateway.calls).not.toContain("registerPending");
    stored?.();
    await harness.idFor("req-ordered");
    harness.registry.cancelAll("shutdown", "done");
    await decision;
  });

  test("denies without registering when the events before it cannot be stored", async () => {
    const harness = registry({
      eventsStored: async () => {
        throw new Error("owner lost");
      },
    });
    const decision = await harness.ask(permission("req-broken"));

    expect(decision.kind).toBe("cancelled");
    expect(
      decision.kind === "cancelled" ? (decision.message ?? "") : "",
    ).toContain("owner lost");
    expect(harness.gateway.calls).not.toContain("registerPending");
    await harness.registry.flush(100);
    // There is no row, so there is nothing to settle.
    expect(harness.gateway.settled).toEqual([]);
  });

  test("mints a new id for every callback, even when the engine repeats its own", async () => {
    const harness = registry();
    const first = harness.ask(permission("req-same"));
    const firstId = await harness.idFor("req-same");
    harness.registry.cancelAll("shutdown", "next");
    await first;
    harness.published.length = 0;
    const second = harness.ask(permission("req-same"));
    const secondId = await harness.idFor("req-same");
    expect(secondId).not.toBe(firstId);
    harness.registry.cancelAll("shutdown", "done");
    await second;
  });

  test("passes a denial's reason to the callback", async () => {
    const harness = registry();
    const decision = harness.ask(permission("req-deny"));
    await harness.answer({
      request_id: "req-deny",
      kind: "permission",
      decision: "deny",
      reason: "Not on production",
    });

    expect(await decision).toEqual({
      kind: "selected",
      optionKind: "reject_once",
      message: "Not on production",
    });
  });

  describe("allowing for the session", () => {
    const offer = [{ toolName: "Bash", ruleContent: "git status:*" }];
    const offered = (requestId: string): ApprovalRequested => {
      const base = permission(requestId, "git status");
      return base.kind === "permission"
        ? { ...base, rememberOffer: offer }
        : base;
    };

    test("registers the offer in the wire's names, only when there is one", async () => {
      const harness = registry();
      void harness.ask(offered("req-offer"));
      void harness.ask(permission("req-plain"));
      await harness.idFor("req-offer");
      await harness.idFor("req-plain");

      const [withOffer, without] = harness.gateway.registered();
      expect(withOffer?.request).toMatchObject({
        remember_offer: [{ tool_name: "Bash", rule_content: "git status:*" }],
      });
      expect(without?.request).not.toHaveProperty("remember_offer");
    });

    test("hands the run the registered rules with an allow that asked to remember", async () => {
      const harness = registry();
      const decision = harness.ask(offered("req-session"));
      await harness.answer({
        request_id: "req-session",
        kind: "permission",
        decision: "allow",
        remember: "session",
      });
      expect(await decision).toEqual({
        kind: "selected",
        optionKind: "allow_once",
        remember: { scope: "session", rules: offer },
      });
    });

    test("allows only this call when the request registered nothing to remember", async () => {
      const harness = registry();
      const decision = harness.ask(permission("req-nothing"));
      await harness.answer({
        request_id: "req-nothing",
        kind: "permission",
        decision: "allow",
        remember: "session",
      });
      expect(await decision).toEqual({
        kind: "selected",
        optionKind: "allow_once",
      });
    });

    test("tells the gateway on every poll that it can take a remembered answer", async () => {
      const harness = registry();
      void harness.ask(offered("req-poll"));
      await harness.idFor("req-poll");
      await waitFor(
        () => harness.gateway.pollRequests.length > 0,
        "the first pending-control poll",
      );
      for (const poll of harness.gateway.pollRequests) {
        expect(poll.capabilities).toEqual({
          approval_remember: true,
          platform_tool_trust: true,
          permission_rules: true,
          engine_settings: true,
          user_env: true,
          response_language: true,
        });
      }
    });
  });

  test("leaves a denial with no reason for the runtime to word", async () => {
    const harness = registry();
    const decision = harness.ask(permission("req-bare"));
    await harness.answer({
      request_id: "req-bare",
      kind: "permission",
      decision: "deny",
    });

    expect(await decision).toEqual({
      kind: "selected",
      optionKind: "reject_once",
    });
  });

  test("registers the run's questions and hands their answer back by id", async () => {
    const harness = registry();
    const decision = harness.ask(question("req-question"));
    await harness.idFor("req-question");

    const [registration] = harness.gateway.registered();
    expect(registration?.request).toEqual({
      kind: "question",
      questions: [
        {
          question_id: "q0",
          prompt: "Which environment?",
          options: [
            { option_id: "q0o0", label: "staging" },
            { option_id: "q0o1", label: "production" },
          ],
          multi_select: false,
          allow_free_text: true,
        },
      ],
    });

    await harness.answer({
      request_id: "req-question",
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o1"] }],
    });

    expect(await decision).toEqual({
      kind: "answered",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o1"] }],
    });
  });

  test("carries free text through as the answer", async () => {
    const harness = registry();
    const decision = harness.ask(question("req-free"));
    await harness.answer({
      request_id: "req-free",
      kind: "question",
      answers: [
        {
          question_id: "q0",
          selected_option_ids: [],
          free_text: "somewhere else",
        },
      ],
    });

    expect(await decision).toEqual({
      kind: "answered",
      answers: [
        {
          question_id: "q0",
          selected_option_ids: [],
          free_text: "somewhere else",
        },
      ],
    });
  });

  test.each([
    ["stale", { outcome: "cancelled", answer_result: "stale" }],
    ["unknown", { outcome: "answered", answer_result: "unknown" }],
    ["refused by a throw", { outcome: "cancelled" }],
  ] as const)(
    "reports an answer the run calls %s as %o",
    async (said, settled) => {
      const harness = registry();
      const decision = harness.ask(
        permission("req-said"),
        said === "refused by a throw" ? new Error("run closed") : said,
      );
      const requestId = await harness.answer({
        request_id: "req-said",
        kind: "permission",
        decision: "allow",
      });

      expect((await decision).kind).toBe("selected");
      await waitFor(() => harness.gateway.settled.length === 1, "settlement");
      // Stale never reached the engine. Unknown may have, and a cancelled
      // receipt would hide a tool that ran.
      expect(harness.gateway.settled).toEqual([
        { request_id: requestId, ...settled },
      ]);
      expect(
        pendingControlRequestSchema.safeParse({
          ...scope,
          answers_after: 0,
          settled: harness.gateway.settled,
        }).success,
      ).toBe(true);
    },
  );

  test("holds an answer's outcome until the run says, and a flush waits for it", async () => {
    const harness = registry();
    let say: ((result: AnswerResult) => void) | undefined;
    let handed = false;
    harness.registry.request(permission("req-slow"), () => {
      handed = true;
      return new Promise<AnswerResult>((resolve) => {
        say = resolve;
      });
    });
    const requestId = await harness.answer({
      request_id: "req-slow",
      kind: "permission",
      decision: "allow",
    });
    await waitFor(() => handed, "the answer reaching the run");
    // Polls keep running meanwhile; none may report the request yet, and
    // none may call it cancelled for want of a holder.
    harness.registry.poll(true);
    await Bun.sleep(20);
    expect(harness.gateway.settled).toEqual([]);

    const flushed = harness.registry.flush(1_000);
    setTimeout(() => say?.("applied"), 20);
    await flushed;

    expect(harness.gateway.settled).toEqual([
      { request_id: requestId, outcome: "answered", answer_result: "applied" },
    ]);
  });

  test("does not call an answer cancelled when its registration returns while the run decides", async () => {
    const fake = new FakeWorkerGateway();
    let registered: (() => void) | undefined;
    const late = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const harness = registry({
      gateway: {
        async registerPending(request) {
          const response = await fake.registerPending(request);
          await late;
          return response;
        },
        pendingControl: (request) => fake.pendingControl(request),
      },
    });
    let say: ((result: AnswerResult) => void) | undefined;
    harness.registry.request(
      permission("req-race"),
      () =>
        new Promise<AnswerResult>((resolve) => {
          say = resolve;
        }),
    );
    await waitFor(() => fake.registered().length === 1, "the registration");
    const requestId = fake.registered()[0]?.request_id ?? "";
    fake.answer({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    harness.registry.poll(true);
    await waitFor(() => say !== undefined, "the answer reaching the run");

    registered?.();
    await Bun.sleep(20);
    say?.("applied");
    await harness.registry.flush(1_000);

    expect(fake.settled).toEqual([
      { request_id: requestId, outcome: "answered", answer_result: "applied" },
    ]);
  });

  test("refuses a question the run gave nothing to show for", async () => {
    const harness = registry();
    const decision = await harness.ask(question("req-empty", []));

    expect(decision).toEqual({
      kind: "cancelled",
      reason: "refused",
      message: "The question cannot be shown without its redacted values",
    });
    expect(harness.gateway.registered()).toEqual([]);
  });

  test.each([
    [
      "names a question nobody asked",
      [{ question_id: "q9", selected_option_ids: ["q9o0"] }],
      "No question q9",
    ],
    [
      "names an option the question does not offer",
      [{ question_id: "q0", selected_option_ids: ["q0o7"] }],
      "no option q0o7",
    ],
    [
      "picks two options of a single-select question",
      [{ question_id: "q0", selected_option_ids: ["q0o0", "q0o1"] }],
      "takes one option",
    ],
    [
      "answers one question twice",
      [
        { question_id: "q0", selected_option_ids: ["q0o0"] },
        { question_id: "q0", selected_option_ids: ["q0o1"] },
      ],
      "answered twice",
    ],
    ["leaves the question unanswered", [], "q0 was not answered"],
  ] as const)("denies an answer that %s", async (_label, answers, message) => {
    const harness = registry();
    const decision = harness.ask(question("req-bad"));
    const requestId = await harness.answer({
      request_id: "req-bad",
      kind: "question",
      answers: answers.map((answer) => ({
        ...answer,
        selected_option_ids: [...answer.selected_option_ids],
      })),
    });

    const settled = await decision;
    expect(settled.kind).toBe("cancelled");
    expect(
      settled.kind === "cancelled" ? (settled.message ?? "") : "",
    ).toContain(message);
    // Dropped, not delivered: the receipt must not read as succeeded.
    await waitFor(() => harness.gateway.settled.length === 1, "settlement");
    expect(harness.gateway.settled).toEqual([
      { request_id: requestId, outcome: "cancelled", reason: "refused" },
    ]);
  });

  test("refuses an answer given for other arguments than the callback's", async () => {
    const harness = registry();
    const decision = harness.ask(permission("req-swapped"));
    const requestId = await harness.idFor("req-swapped");
    const [registration] = harness.gateway.registered();
    // A registration under the same id with different arguments, as a
    // collision would produce.
    harness.gateway.registrations.unshift({
      ...(registration as RegisterPendingRequest),
      input_hash: "f".repeat(64),
    });
    harness.gateway.answer({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });

    expect(await decision).toEqual({
      kind: "cancelled",
      reason: "refused",
      message: "The answer was given for different tool arguments",
    });
  });

  test("denies what the gateway will not take, and retries what it merely could not", async () => {
    let attempts = 0;
    const flaky: PendingRequestsOptions["gateway"] = {
      async registerPending(): Promise<RegisterPendingResponse> {
        attempts += 1;
        if (attempts === 1) {
          throw new WorkerGatewayRequestError(0, null, "socket closed", true);
        }
        throw new WorkerGatewayRequestError(
          404,
          "NOT_FOUND",
          "This gateway does not serve pending requests",
          false,
        );
      },
      async pendingControl(): Promise<PendingControlResponse> {
        return { control: null, answers: [] };
      },
    };
    const harness = registry({ gateway: flaky });

    const decision = await harness.ask(permission("req-refused"));

    expect(attempts).toBe(2);
    expect(decision.kind).toBe("cancelled");
    expect(
      decision.kind === "cancelled" ? (decision.message ?? "") : "",
    ).toContain("does not serve pending requests");
    // Nobody was told about a request nobody could answer.
    expect(harness.published).toHaveLength(0);
  });

  test("gives up the session when registration learns it lost ownership", async () => {
    const gateway: PendingRequestsOptions["gateway"] = {
      async registerPending(): Promise<RegisterPendingResponse> {
        throw new WorkerGatewayRequestError(
          409,
          "STALE_EPOCH",
          "Another epoch owns this session",
          false,
        );
      },
      async pendingControl(): Promise<PendingControlResponse> {
        throw new WorkerGatewayRequestError(
          409,
          "STALE_EPOCH",
          "Another epoch owns this session",
          false,
        );
      },
    };
    const harness = registry({ gateway });

    const decision = await harness.ask(permission("req-owner"));

    expect(decision).toEqual({
      kind: "cancelled",
      reason: "shutdown",
      message: "This worker no longer owns the session",
    });
    expect(harness.lost.length).toBeGreaterThan(0);
  });

  test("holds several requests independently and answers them out of order", async () => {
    const harness = registry();
    const first = harness.ask(permission("req-1"));
    const second = harness.ask(permission("req-2", "pwd"));
    await harness.idFor("req-1");
    await harness.idFor("req-2");
    expect(harness.registry.outstanding).toBe(2);

    await harness.answer({
      request_id: "req-2",
      kind: "permission",
      decision: "allow",
    });
    expect(await second).toEqual({
      kind: "selected",
      optionKind: "allow_once",
    });
    expect(harness.registry.outstanding).toBe(1);

    await harness.answer({
      request_id: "req-1",
      kind: "permission",
      decision: "deny",
      reason: "no",
    });
    expect(await first).toEqual({
      kind: "selected",
      optionKind: "reject_once",
      message: "no",
    });
  });

  test("denies a request nobody answered before it expired, and says so", async () => {
    const gateway = new FakeWorkerGateway();
    const register = gateway.registerPending.bind(gateway);
    gateway.registerPending = async (request) => ({
      ...(await register(request)),
      expires_in_ms: 5,
    });
    const harness = registry({ gateway });
    const decision = await harness.ask(permission("req-late"));

    expect(decision.kind).toBe("cancelled");
    expect(
      decision.kind === "cancelled" ? (decision.message ?? "") : "",
    ).toContain("No answer arrived");
    await waitFor(() => gateway.settled.length === 1, "settlement");
    expect(gateway.settled[0]?.outcome).toBe("expired");
  });

  test("never waits longer than the gateway takes answers", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.registerPending = async (request) => ({
      request_id: request.request_id,
      expires_at: new Date(Date.now() + 5).toISOString(),
      expires_in_ms: 5,
    });
    const harness = registry({ gateway, timeoutMs: 60_000 });
    const started = Date.now();

    const decision = await harness.ask(permission("req-short"));

    expect(decision.kind).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("waits as long as the gateway takes answers, past its own timeout", async () => {
    const gateway = new FakeWorkerGateway();
    const register = gateway.registerPending.bind(gateway);
    gateway.registerPending = async (request) => ({
      ...(await register(request)),
      expires_in_ms: 60_000,
    });
    const harness = registry({ gateway, timeoutMs: 5 });
    const decision = harness.ask(permission("req-long"));
    const requestId = await harness.idFor("req-long");
    await Bun.sleep(50);
    gateway.answer({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });

    expect(await decision).toEqual({
      kind: "selected",
      optionKind: "allow_once",
    });
  });

  test("denies a registered request at the gateway's expiry, not at its own timeout", async () => {
    const gateway = new FakeWorkerGateway();
    const register = gateway.registerPending.bind(gateway);
    gateway.registerPending = async (request) => ({
      ...(await register(request)),
      expires_in_ms: 150,
    });
    const harness = registry({ gateway, timeoutMs: 5 });
    const started = performance.now();

    const decision = await harness.ask(permission("req-expiry"));

    expect(decision.kind).toBe("cancelled");
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    await waitFor(() => gateway.settled.length === 1, "settlement");
    expect(gateway.settled[0]?.outcome).toBe("expired");
  });

  test("gives up on a request the gateway never registered after its own timeout", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.registerPending = () => new Promise(() => {});
    const harness = registry({ gateway, timeoutMs: 5 });

    const decision = await harness.ask(permission("req-stuck"));

    expect(decision).toEqual({
      kind: "cancelled",
      reason: "expired",
      message: "No answer arrived within 0s",
    });
  });

  test("refuses an answer of the wrong kind rather than applying it", async () => {
    const harness = registry();
    const decision = harness.ask(permission("req-mixed"));
    await harness.answer({
      request_id: "req-mixed",
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o0"] }],
    });

    expect(await decision).toEqual({
      kind: "cancelled",
      reason: "refused",
      message: "A question answer cannot settle a permission request",
    });
  });

  test.each(["park", "shutdown", "interrupt", "refused"] as const)(
    "cancels everything still waiting for %s, never as a person's deny, and reports why",
    async (reason) => {
      const harness = registry();
      const decision = harness.ask(permission("req-cancel"));
      const requestId = await harness.idFor("req-cancel");
      harness.registry.cancelAll(reason, "Worker is shutting down");

      expect(await decision).toEqual({
        kind: "cancelled",
        reason,
        message: "Worker is shutting down",
      });
      await harness.registry.flush(1_000);
      expect(harness.gateway.settled).toEqual([
        { request_id: requestId, outcome: "cancelled", reason },
      ]);
    },
  );

  test("tells the run each way a request is cancelled, and a person's deny apart from them", async () => {
    const said: ApprovalDecisionPayload[] = [];
    const gateway = new FakeWorkerGateway();
    const register = gateway.registerPending.bind(gateway);
    gateway.registerPending = async (request) => ({
      ...(await register(request)),
      // Only the request named for it expires before anyone answers.
      expires_in_ms:
        request.input_hash === permission("", "sleep 9").inputHash ? 5 : 60_000,
    });
    const harness = registry({ gateway });
    const settle = (name: string, command = "ls") =>
      new Promise<void>((resolve) =>
        harness.registry.request(
          permission(name, command),
          async (decision) => {
            said.push(decision);
            resolve();
            return "applied";
          },
        ),
      );

    await settle("req-expired", "sleep 9");

    const denied = settle("req-denied");
    gateway.answer({
      request_id: await harness.idFor("req-denied"),
      kind: "permission",
      decision: "deny",
      reason: "not that",
    });
    await denied;

    const swapped = settle("req-swapped", "pwd");
    const swappedId = await harness.idFor("req-swapped");
    const registration = gateway
      .registered()
      .find((item) => item.request_id === swappedId);
    gateway.registrations.unshift({
      ...(registration as RegisterPendingRequest),
      input_hash: "f".repeat(64),
    });
    gateway.answer({
      request_id: swappedId,
      kind: "permission",
      decision: "allow",
    });
    await swapped;

    const mixed = settle("req-mixed", "whoami");
    gateway.answer({
      request_id: await harness.idFor("req-mixed"),
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o0"] }],
    });
    await mixed;

    const interrupted = settle("req-interrupted", "date");
    await harness.idFor("req-interrupted");
    harness.registry.cancelAll("interrupt", "The turn was interrupted");
    await interrupted;

    expect(
      said.map((decision) =>
        decision.kind === "cancelled" ? decision.reason : decision,
      ),
    ).toEqual([
      "expired",
      { kind: "selected", optionKind: "reject_once", message: "not that" },
      "refused",
      "refused",
      "interrupt",
    ]);
    await harness.registry.flush(1_000);
    expect(
      gateway.settled.map(({ outcome, reason }) => [outcome, reason ?? null]),
    ).toEqual([
      ["expired", null],
      ["answered", null],
      ["cancelled", "refused"],
      ["cancelled", "refused"],
      ["cancelled", "interrupt"],
    ]);
  });

  test("settles a park that did not take as cancelled for the park, never as a deny", async () => {
    const harness = registry();
    const decision = harness.ask(permission("req-park"));
    const requestId = await harness.idFor("req-park");
    harness.registry.park();

    expect(await decision).toEqual({ kind: "cancelled", reason: "park" });
    await harness.registry.flush(1_000);
    expect(harness.gateway.settled).toEqual([]);
    harness.registry.unpark();
    await harness.registry.flush(1_000);
    expect(harness.gateway.settled).toEqual([
      { request_id: requestId, outcome: "cancelled", reason: "park" },
    ]);
  });

  test("stops waiting, and answers nothing, when the run withdraws a request", async () => {
    const harness = registry();
    let answered = false;
    harness.registry.request(permission("req-abort"), async () => {
      answered = true;
      return "applied";
    });
    const requestId = await harness.idFor("req-abort");
    harness.registry.withdraw("local_req-abort");

    expect(harness.registry.outstanding).toBe(0);
    await harness.registry.flush(1_000);
    expect(answered).toBe(false);
    expect(harness.gateway.settled).toEqual([
      { request_id: requestId, outcome: "cancelled" },
    ]);
  });

  test("reports an answer whose callback is already gone instead of dropping it", async () => {
    const harness = registry();
    const decision = harness.ask(permission("req-gone"));
    const requestId = await harness.idFor("req-gone");
    harness.registry.cancelAll("shutdown", "gone");
    await decision;
    await harness.registry.flush(1_000);
    harness.gateway.settled.length = 0;
    // An answer for it still reaches this worker (it was stored just before
    // the settlement landed); a live request keeps the poll going.
    harness.gateway.answer({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    const other = harness.ask(permission("req-other"));
    await waitFor(
      () => harness.gateway.settled.some((s) => s.request_id === requestId),
      "the stray answer's settlement",
    );
    expect(
      harness.gateway.settled.find((s) => s.request_id === requestId)?.outcome,
    ).toBe("cancelled");
    harness.registry.cancelAll("shutdown", "done");
    await other;
  });

  test("replays a registration whose reply was lost after its callback closed, then settles it", async () => {
    const gateway = new FakeWorkerGateway();
    const original = gateway.registerPending.bind(gateway);
    let calls = 0;
    let release: (() => void) | undefined;
    gateway.registerPending = async (request) => {
      calls += 1;
      if (calls === 1) {
        // The row commits only after the callback's settlement went out,
        // and the reply never makes it back.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await original(request);
        throw new WorkerGatewayRequestError(0, null, "socket closed", true);
      }
      return original(request);
    };
    const harness = registry({ gateway });
    void harness.ask(permission("req-lost"));
    await waitFor(() => release !== undefined, "the held registration");
    harness.registry.withdraw("local_req-lost");
    await waitFor(() => harness.registry.outstanding === 0, "the close");
    expect(gateway.settled).toEqual([]);
    release?.();
    await harness.registry.flush(1_000);

    expect(calls).toBe(2);
    const requestId = gateway.registrations[0]?.request_id ?? "";
    expect(gateway.settled).toEqual([
      { request_id: requestId, outcome: "cancelled" },
    ]);
    // The row did commit, and the gateway wrote its question with it; the
    // settlement is what closes it for whoever saw that.
    expect(harness.published).toHaveLength(1);
  });

  test("stops retrying a registration of unknown outcome once stopped", async () => {
    let calls = 0;
    const down: PendingRequestsOptions["gateway"] = {
      async registerPending(): Promise<RegisterPendingResponse> {
        calls += 1;
        throw new WorkerGatewayRequestError(0, null, "socket closed", true);
      },
      async pendingControl(): Promise<PendingControlResponse> {
        throw new WorkerGatewayRequestError(0, null, "socket closed", true);
      },
    };
    const harness = registry({ gateway: down });
    const decision = harness.ask(permission("req-down"));
    await waitFor(() => calls > 0, "the first registration");
    harness.registry.cancelAll("shutdown", "drain");
    await decision;
    // The callback is gone but the row may exist: the retries go on.
    await waitFor(() => calls > 2, "the retries after the close");
    harness.registry.stop();
    await harness.registry.flush(50);
    const settled = calls;
    await Bun.sleep(50);
    expect(calls).toBe(settled);
    expect((await harness.ask(permission("req-late"))).kind).toBe("cancelled");
  });

  test("a forced poll picks up an answer for a request this worker no longer holds", async () => {
    const harness = registry();
    const decision = harness.ask(permission("req-orphan"));
    const requestId = await harness.idFor("req-orphan");
    harness.registry.cancelAll("shutdown", "gone");
    await decision;
    await harness.registry.flush(1_000);
    // The gateway lost the settlement's effect; only its heartbeat says an
    // answer is waiting.
    harness.gateway.settled.length = 0;
    harness.gateway.answer({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    harness.registry.poll();
    expect(harness.gateway.settled).toEqual([]);
    harness.registry.poll(true);
    await waitFor(
      () => harness.gateway.settled.length > 0,
      "the orphan's settlement",
    );
    expect(harness.gateway.settled).toEqual([
      { request_id: requestId, outcome: "cancelled" },
    ]);
  });

  test("keeps a settlement made while a poll carrying others is in flight", async () => {
    const seen: PendingControlRequest[] = [];
    let release: (() => void) | undefined;
    const gateway = new FakeWorkerGateway();
    const original = gateway.pendingControl.bind(gateway);
    gateway.pendingControl = async (request) => {
      seen.push(request);
      if (seen.length === 1 && release === undefined) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(request);
    };
    const harness = registry({ gateway });
    const first = harness.ask(permission("req-x"));
    const second = harness.ask(permission("req-y", "pwd"));
    const x = await harness.idFor("req-x");
    const y = await harness.idFor("req-y");
    await waitFor(() => release !== undefined, "the held poll");
    harness.registry.cancelAll("shutdown", "stop");
    await first;
    await second;
    release?.();
    await harness.registry.flush(1_000);

    expect(gateway.settled.map((s) => s.request_id).sort()).toEqual(
      [x, y].sort(),
    );
  });

  test("never replays an answer it already consumed", async () => {
    const harness = registry();
    const first = harness.ask(permission("req-a"));
    await harness.answer({
      request_id: "req-a",
      kind: "permission",
      decision: "allow",
    });
    await first;

    const polls: number[] = [];
    const original = harness.gateway.pendingControl.bind(harness.gateway);
    harness.gateway.pendingControl = async (request) => {
      polls.push(request.answers_after);
      return original(request);
    };
    const second = harness.ask(permission("req-b", "pwd"));
    await harness.idFor("req-b");
    expect(harness.registry.outstanding).toBe(1);
    await harness.answer({
      request_id: "req-b",
      kind: "permission",
      decision: "allow",
    });
    expect(await second).toEqual({
      kind: "selected",
      optionKind: "allow_once",
    });
    // The second poll cycle starts past the answer the first request consumed.
    expect(polls.every((after) => after >= 1)).toBe(true);
  });

  test("settles by outcome alone, and says so, with a gateway older than reasons and answer results", async () => {
    const gateway = new FakeWorkerGateway();
    const original = gateway.pendingControl.bind(gateway);
    let refused = 0;
    // A strict schema from before the two fields: the whole poll is a 400.
    gateway.pendingControl = async (request) => {
      const detailed = (request.settled ?? []).some(
        (item) => item.reason !== undefined || item.answer_result !== undefined,
      );
      if (detailed) {
        refused += 1;
        throw new WorkerGatewayRequestError(
          400,
          "BAD_REQUEST",
          "POST /pending/control failed with BAD_REQUEST: Request body is invalid",
          false,
        );
      }
      return original(request);
    };
    const warned: string[] = [];
    const harness = registry({
      gateway,
      onSettlementDetailRefused: (error) => warned.push(error.message),
    });
    const allowed = harness.ask(permission("req-old-a"));
    const allowedId = await harness.idFor("req-old-a");
    gateway.answer({
      request_id: allowedId,
      kind: "permission",
      decision: "allow",
    });
    await allowed;
    const cancelled = harness.ask(permission("req-old-b", "pwd"));
    const cancelledId = await harness.idFor("req-old-b");
    harness.registry.cancelAll("interrupt", "The turn was interrupted");
    await cancelled;
    await harness.registry.flush(1_000);

    expect(refused).toBe(1);
    expect(warned).toHaveLength(1);
    expect(gateway.settled).toEqual([
      { request_id: allowedId, outcome: "answered" },
      { request_id: cancelledId, outcome: "cancelled" },
    ]);
  });

  test("sends a settlement backlog larger than one call carries, in batches", async () => {
    const gateway = new FakeWorkerGateway();
    const original = gateway.pendingControl.bind(gateway);
    const sizes: number[] = [];
    // The transport the real route has: a body over the cap is a 400.
    gateway.pendingControl = async (request) => {
      if (!pendingControlRequestSchema.safeParse(request).success) {
        throw new WorkerGatewayRequestError(
          400,
          "BAD_REQUEST",
          "invalid",
          false,
        );
      }
      sizes.push(request.settled?.length ?? 0);
      return original(request);
    };
    const harness = registry({ gateway });
    const count = PENDING_SETTLEMENTS_MAX + 1;
    const decisions = Array.from({ length: count }, (_, index) =>
      harness.ask(permission(`req-many-${index}`, `echo ${index}`)),
    );
    await waitFor(
      () => gateway.registered().length === count,
      "every registration",
    );
    harness.registry.cancelAll("shutdown", "stop");
    await Promise.all(decisions);
    await harness.registry.flush(2_000);

    expect(gateway.settled).toHaveLength(count);
    expect(Math.max(...sizes)).toBe(PENDING_SETTLEMENTS_MAX);
  });
  test("applies the answers a poll brings before the control it brings, and says it did", async () => {
    const seen: Array<{ answered: boolean; outstanding: number }> = [];
    let instance: PendingRequestRegistry | undefined;
    const harness = registry({
      onControl: (_control, { answered }) =>
        seen.push({ answered, outstanding: instance?.outstanding ?? -1 }),
    });
    instance = harness.registry;
    const decision = harness.ask(permission("req-1"));
    const requestId = await harness.idFor("req-1");
    harness.gateway.control = {
      control_id: "0b6f7d1e-6a55-4c1e-9d59-2f7ad3a4c0aa",
      kind: "park",
      target_turn_id: null,
      issued_at: "2026-10-27T00:00:00.000Z",
    };
    harness.gateway.answer({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });

    expect(await decision).toEqual({
      kind: "selected",
      optionKind: "allow_once",
    });
    await waitFor(() => seen.length > 0, "the control");
    expect(seen[0]).toEqual({ answered: true, outstanding: 0 });
  });

  test("a refresh polls at once even while the loop sleeps out its interval", async () => {
    const harness = registry({ pollIntervalMs: 60_000 });
    const decision = harness.ask(permission("req-1"));
    const requestId = await harness.idFor("req-1");
    await waitFor(
      () => harness.gateway.calls.includes("pendingControl"),
      "the first poll",
    );
    harness.gateway.answer({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });

    await harness.registry.refresh(1_000);

    expect(harness.registry.outstanding).toBe(0);
    expect(await decision).toEqual({
      kind: "selected",
      optionKind: "allow_once",
    });
    harness.registry.stop();
  });
});

describe("attachments", () => {
  test("hands each order to the host, and reports its outcome until a poll lands", async () => {
    const orders: string[][] = [];
    let failNext = true;
    const fake = new FakeWorkerGateway();
    const harness = registry({
      onAttachments: (batch) => orders.push(batch.map((order) => order.id)),
      gateway: {
        registerPending: (request) => fake.registerPending(request),
        pendingControl: async (request) => {
          if (request.attached !== undefined && failNext) {
            failNext = false;
            throw new WorkerGatewayRequestError(
              503,
              "BACKEND_UNAVAILABLE",
              "x",
              true,
            );
          }
          return fake.pendingControl(request);
        },
      },
    });
    fake.attachOrders = [
      {
        id: "docs",
        url: "https://github.com/acme/docs.git",
        branch: "main",
        receipt_id: "r-1",
      },
    ];
    harness.registry.poll(true);
    await waitFor(() => orders.length > 0, "the order");
    expect(orders[0]).toEqual(["docs"]);

    const report = {
      repository_id: "docs",
      receipt_id: "r-1",
      status: "attached" as const,
      commit: "e".repeat(40),
    };
    harness.registry.reportAttached(report);
    await waitFor(() => fake.attachReports.length > 0, "the report");
    expect(fake.attachReports).toEqual([report]);
    expect(fake.attachOrders).toEqual([]);
    // Held while its report was unsent, so not handed to the host again.
    expect(orders).toHaveLength(1);
    harness.registry.stop();
  });
});
