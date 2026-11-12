import { describe, expect, test } from "bun:test";
import {
  type AdminSession,
  auditReadResponseSchema,
  listAdminSessionsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  type SessionDetail,
  type SessionShareView,
  setSessionShareResponseSchema,
  terminateSessionResponseSchema,
} from "@werft-ai/contracts";
import {
  type SessionService,
  SessionServiceError,
  type SessionShareService,
} from "@werft-ai/platform";
import { errorOf } from "../../../testing/api-error.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerSessionShareRoutes } from "./session-shares.ts";

const createApiApp = recordRouteErrors(
  "routes/musterrolle/session-shares.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const USER = "019a0000-0000-7000-8000-0000000000c1";
const TEAM = "019a0000-0000-7000-8000-00000000b0a1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";
const owner = { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" };
const PAD = "x".repeat(REQUEST_BODY_MAX_BYTES);

const SHARE: SessionShareView = {
  session_id: SESSION,
  scope: "team",
  user_ids: [],
  team_ids: [TEAM],
  revision: 1,
  updated_by: USER,
  updated_at: "2026-10-11T00:00:00.000Z",
  audience_limited: false,
};

const DETAIL: SessionDetail = {
  id: SESSION,
  title: null,
  agent: null,
  agent_hidden: false,
  created_by: null,
  channel: null,
  slack_permalink: null,
  revision: 3,
  admission_state: "active",
  status: "running",
  runtime: null,
  model: null,
  repository_id: null,
  repository: null,
  current_turn_id: null,
  queued_turn_count: 0,
  last_event_at: null,
  created_at: "2026-10-11T00:00:00.000Z",
  updated_at: "2026-10-11T00:00:00.000Z",
  execution: null,
  checkpoint_revision: null,
  pending_request_count: 0,
  attention: null,
  durability: {
    last_transcript_persisted_at: null,
    checkpoint_committed_at: null,
    checkpoint_revision: null,
    last_completed_turn_id: null,
    last_checkpointed_turn_id: null,
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
};

const fails =
  (code: ConstructorParameters<typeof SessionServiceError>[0]) => async () => {
    throw new SessionServiceError(code, "refused", undefined, {
      reason_code: "justification_required",
    });
  };

function app(
  shares: Partial<SessionShareService>,
  sessions: Partial<
    Pick<SessionService, "auditRead" | "terminateSession" | "decideRecovery">
  > = {},
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerSessionShareRoutes(
        router,
        shares as SessionShareService,
        sessions as SessionService,
      ),
  });
}

function call(
  api: ReturnType<typeof app>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return api.request(path, {
    method,
    headers: { ...owner, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("GET /v1/sessions/{id}/share", () => {
  test("answers the share, or not found", async () => {
    const found = await call(
      app({ getShare: async () => SHARE }),
      "GET",
      `/v1/sessions/${SESSION}/share`,
    );
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(SHARE);
    const missing = await call(
      app({ getShare: fails("NOT_FOUND") }),
      "GET",
      `/v1/sessions/${SESSION}/share`,
    );
    expect(missing.status).toBe(404);
  });
});

describe("POST /v1/sessions/{id}/share", () => {
  const path = `/v1/sessions/${SESSION}/share`;

  test("changes the share with the targets its scope names", async () => {
    let asked: unknown;
    const response = await call(
      app({
        setShare: async (_caller, _id, body) => {
          asked = body;
          return { share: SHARE, receipt_id: RECEIPT };
        },
      }),
      "POST",
      path,
      { scope: "team", team_ids: [TEAM], expected_revision: 0 },
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual({
      scope: "team",
      team_ids: [TEAM],
      expected_revision: 0,
    });
    expect(
      setSessionShareResponseSchema.parse(await response.json()).receipt_id,
    ).toBe(RECEIPT);
  });

  test("targets must match the scope", async () => {
    const api = app({});
    for (const body of [
      { scope: "team" },
      { scope: "people", user_ids: [] },
      { scope: "private", user_ids: [USER] },
      { scope: "workspace", team_ids: [TEAM] },
      { scope: "everyone" },
    ]) {
      expect((await call(api, "POST", path, body)).status).toBe(400);
    }
    expect(
      (await call(api, "POST", path, { scope: "private", pad: PAD })).status,
    ).toBe(413);
  });

  test("every refusal maps to its status", async () => {
    for (const [code, status] of [
      ["BAD_REQUEST", 400],
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["REVISION_CONFLICT", 409],
    ] as const) {
      const response = await call(
        app({ setShare: fails(code) }),
        "POST",
        path,
        { scope: "private" },
      );
      expect(response.status).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
    }
  });
});

describe("POST /v1/sessions/{id}/audit-read", () => {
  const path = `/v1/sessions/${SESSION}/audit-read`;

  test("passes the reason and the page to the read", async () => {
    let asked: unknown;
    const response = await call(
      app(
        {},
        {
          auditRead: async (_caller, _id, input) => {
            asked = input;
            return {
              session: DETAIL,
              turns: { items: [], next_cursor: null },
            };
          },
        },
      ),
      "POST",
      path,
      { justification: "  incident 42 ", limit: 10 },
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual({ justification: "incident 42", limit: 10 });
    expect(auditReadResponseSchema.parse(await response.json())).toEqual({
      session: DETAIL,
      turns: { items: [], next_cursor: null },
    });
  });

  test("a read without a reason is refused before the service", async () => {
    let reached = false;
    const api = app(
      {},
      {
        auditRead: async () => {
          reached = true;
          throw new Error("unreachable");
        },
      },
    );
    for (const body of [{}, { justification: "   " }]) {
      expect((await call(api, "POST", path, body)).status).toBe(400);
    }
    expect(
      (await call(api, "POST", path, { justification: "x", pad: PAD })).status,
    ).toBe(413);
    expect(reached).toBe(false);
  });

  test("a refusal keeps its reason code", async () => {
    const refused = await call(
      app({}, { auditRead: fails("FORBIDDEN") }),
      "POST",
      path,
      { justification: "incident 42" },
    );
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).details).toEqual({
      reason_code: "justification_required",
    });
    const missing = await call(
      app({}, { auditRead: fails("NOT_FOUND") }),
      "POST",
      path,
      { justification: "incident 42" },
    );
    expect(missing.status).toBe(404);
  });
});

describe("GET /v1/admin/sessions", () => {
  const ROW: AdminSession = {
    session_id: SESSION,
    created_by_user_id: USER,
    created_by_api_key_id: null,
    agent_release_id: null,
    status: "running",
    admission_state: "active",
    share_scope: "private",
    created_at: "2026-10-11T00:00:00.000Z",
    takeover_required_at: null,
  };

  test("lists metadata, and refuses a non-manager", async () => {
    const listed = await call(
      app({ listForAdmin: async () => ({ items: [ROW] }) }),
      "GET",
      "/v1/admin/sessions",
    );
    expect(listed.status).toBe(200);
    expect(
      listAdminSessionsResponseSchema.parse(await listed.json()).items,
    ).toEqual([ROW]);
    expect(
      (
        await call(
          app({ listForAdmin: fails("FORBIDDEN") }),
          "GET",
          "/v1/admin/sessions",
        )
      ).status,
    ).toBe(403);
  });
});

describe("POST /v1/admin/sessions/{id}/terminate", () => {
  const path = `/v1/admin/sessions/${SESSION}/terminate`;
  const key = { "Idempotency-Key": "key-1" };

  test("terminates with the reason as the justification", async () => {
    let asked: unknown;
    const response = await call(
      app(
        {},
        {
          terminateSession: async (_caller, _id, input) => {
            asked = input;
            return {
              receipt_id: RECEIPT,
              receipt_status: "accepted",
              external_effects_reverted: false,
            };
          },
        },
      ),
      "POST",
      path,
      { expected_revision: 3, justification: "runaway cost" },
      key,
    );
    expect(response.status).toBe(202);
    expect(
      terminateSessionResponseSchema.parse(await response.json()).receipt_id,
    ).toBe(RECEIPT);
    expect(asked).toEqual({
      idempotencyKey: "key-1",
      body: { expected_revision: 3 },
      justification: "runaway cost",
    });
  });

  test("a reason, a revision and a key are required", async () => {
    const api = app({});
    expect(
      (await call(api, "POST", path, { expected_revision: 3 }, key)).status,
    ).toBe(400);
    expect(
      (
        await call(api, "POST", path, {
          expected_revision: 3,
          justification: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          api,
          "POST",
          path,
          { expected_revision: 3, justification: "x", pad: PAD },
          key,
        )
      ).status,
    ).toBe(413);
  });

  test("every refusal maps to its status", async () => {
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["REVISION_CONFLICT", 409],
      ["UNSUPPORTED_CAPABILITY", 422],
    ] as const) {
      const response = await call(
        app({}, { terminateSession: fails(code) }),
        "POST",
        path,
        { expected_revision: 3, justification: "x" },
        key,
      );
      expect(response.status).toBe(status);
    }
  });
});

describe("POST /v1/admin/sessions/{id}/recovery-decisions", () => {
  const path = `/v1/admin/sessions/${SESSION}/recovery-decisions`;
  const key = { "Idempotency-Key": "key-1" };
  const DECISION = {
    decision: "close",
    expected_revision: 3,
    reason: "owner left; customer waiting",
  };

  test("decides with the reason as the justification", async () => {
    let asked: unknown;
    const response = await call(
      app(
        {},
        {
          decideRecovery: async (_caller, _id, input) => {
            asked = input;
            return { receipt_id: RECEIPT, receipt_status: "accepted" };
          },
        },
      ),
      "POST",
      path,
      DECISION,
      key,
    );
    expect(response.status).toBe(202);
    expect(asked).toEqual({
      idempotencyKey: "key-1",
      body: DECISION,
      justification: DECISION.reason,
    });
  });

  test("a reason, a revision and a key are required", async () => {
    const api = app({});
    const { reason: _, ...unreasoned } = DECISION;
    expect((await call(api, "POST", path, unreasoned, key)).status).toBe(400);
    expect((await call(api, "POST", path, DECISION)).status).toBe(400);
    expect(
      (await call(api, "POST", path, { ...DECISION, pad: PAD }, key)).status,
    ).toBe(413);
  });

  test("every refusal maps to its status", async () => {
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["REQUEST_STALE", 409],
      ["UNSUPPORTED_CAPABILITY", 422],
    ] as const) {
      const response = await call(
        app({}, { decideRecovery: fails(code) }),
        "POST",
        path,
        DECISION,
        key,
      );
      expect(response.status).toBe(status);
    }
  });
});
