import { describe, expect, test } from "bun:test";
import type { Principal, PushRequest } from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import type { PushSourceResult } from "../checkpoints/checkpoint-service.ts";
import { createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { PushRequestStore } from "../ports/push-requests.ts";
import { createPushRequestService } from "./push-request-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const COMMIT = "a".repeat(40);

const actor = {
  caller: testCaller("owner-a"),
  principal: {
    kind: "api_key",
    id: "key-1",
    owner_id: "owner-a",
    scopes: [],
  } as unknown as Principal,
  ownerId: "owner-a",
  verified: true,
};

function request(overrides: Partial<PushRequest>): PushRequest {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    session_id: SESSION,
    repository_id: "sample-app",
    checkpoint_revision: 3,
    git_commit: COMMIT,
    target_branch: "agent/x",
    state: "requested",
    origin: "direct",
    ...overrides,
  } as PushRequest;
}

function service(options: {
  pointer: number | null | undefined;
  requests: PushRequest[];
  source: {
    readPushSource: () => Promise<PushSourceResult>;
    readPushSourceAt: () => Promise<PushSourceResult>;
  };
}) {
  return createPushRequestService({
    authorization: createAuthorizationPolicy({
      sessions: { visibleTo: async () => true, originOf: async () => null },
    }),
    store: {
      findSession: async () =>
        options.pointer === undefined
          ? {}
          : { checkpointRevision: options.pointer },
      list: async () => options.requests,
      get: async () => options.requests[0] ?? null,
    } as unknown as PushRequestStore,
    catalog: { profiles: {}, repositories: {} },
    intents: { list: async () => [] } as never,
    source: options.source,
  });
}

const NONE = {
  readPushSource: async (): Promise<PushSourceResult> => ({ status: "none" }),
  readPushSourceAt: async (): Promise<PushSourceResult> => ({
    status: "none",
  }),
};

describe("a listed push request carries what Slack would decide", () => {
  test("a request on the session's current revision can be approved", async () => {
    const push = service({
      pointer: 3,
      requests: [request({})],
      source: NONE,
    });
    const listed = await push.listView(actor, SESSION);
    expect(listed.items[0]?.approvability).toEqual({
      approvable: true,
      reason: null,
    });
  });

  test("a revision the pointer left cannot, and says why", async () => {
    const push = service({
      pointer: 4,
      requests: [request({})],
      source: NONE,
    });
    const got = await push.getView(actor, SESSION, "any");
    expect(got.approvability).toEqual({
      approvable: false,
      reason: { key: "action.push.unapprovable.checkpoint_moved" },
    });
  });

  test("an intent request stays approvable while its pinned revision verifies", async () => {
    const pinned = {
      status: "ready",
      gitCommit: COMMIT,
    } as unknown as PushSourceResult;
    const push = service({
      pointer: 9,
      requests: [request({ origin: "intent" })],
      source: { ...NONE, readPushSourceAt: async () => pinned },
    });
    const listed = await push.listView(actor, SESSION);
    expect(listed.items[0]?.approvability?.approvable).toBe(true);

    const broken = service({
      pointer: 9,
      requests: [request({ origin: "intent" })],
      source: NONE,
    });
    expect(
      (await broken.listView(actor, SESSION)).items[0]?.approvability,
    ).toEqual({
      approvable: false,
      reason: { key: "action.push.unapprovable.pinned_source_invalid" },
    });
  });

  test("an uppercase session id is judged under the stored id, as decide does", async () => {
    const read: string[] = [];
    const stored = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
    const push = service({
      pointer: 4,
      requests: [request({})],
      source: {
        ...NONE,
        readPushSource: async (id: string) => {
          read.push(id);
          return id === stored
            ? ({
                status: "ready",
                revision: 4,
                gitCommit: COMMIT,
              } as unknown as PushSourceResult)
            : { status: "none" };
        },
      } as never,
    });
    const listed = await push.listView(actor, stored.toUpperCase());
    expect(read).toEqual([stored]);
    expect(listed.items[0]?.approvability?.approvable).toBe(true);
  });

  test("the agent's plain get and list carry no verdict and read no checkpoint", async () => {
    let reads = 0;
    const push = service({
      pointer: 4,
      requests: [request({})],
      source: {
        readPushSource: async () => {
          reads += 1;
          return { status: "none" };
        },
        readPushSourceAt: async () => ({ status: "none" }),
      },
    });
    expect("approvability" in (await push.get(actor, SESSION, "any"))).toBe(
      false,
    );
    expect(
      "approvability" in ((await push.list(actor, SESSION)).items[0] ?? {}),
    ).toBe(false);
    expect(reads).toBe(0);
  });

  test("a request that is no longer waiting is not approvable", async () => {
    const push = service({
      pointer: 3,
      requests: [request({ state: "approved" })],
      source: NONE,
    });
    const listed = await push.listView(actor, SESSION);
    expect(listed.items[0]?.approvability?.reason?.key).toBe(
      "action.push.unapprovable.not_requested",
    );
  });
});
