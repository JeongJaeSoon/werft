import { expect, test } from "bun:test";
import { type Principal, scopesForRole } from "@werft-ai/contracts";
import type { OpenLostCheckpointNotice } from "@werft-ai/db";
import {
  callerFor,
  createAuthorizationPolicy,
  SessionServiceError,
} from "@werft-ai/platform";
import { createLostCheckpointNoticesAdmin } from "./lost-checkpoint-notices.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const NOTICE = "019a0000-0000-7000-8000-0000000000b1";
const LATER = "019a0000-0000-7000-8000-0000000000b2";

function person(role: "owner" | "admin" | "member") {
  return callerFor(
    {
      kind: "user",
      id: `019a0000-0000-7000-8000-0000000000c${role.length}`,
      workspace_id: WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    crypto.randomUUID(),
  );
}

const apiKey = callerFor(
  {
    kind: "api_key",
    id: "key-1",
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopesForRole("owner")],
  } as Principal,
  { kind: "api" },
  crypto.randomUUID(),
);

function setup(open: OpenLostCheckpointNotice[]) {
  const closed: { ids: readonly string[]; closedBy: string }[] = [];
  const admin = createLostCheckpointNoticesAdmin({
    authorization: createAuthorizationPolicy({
      agents: { agentOf: async () => null, isAdmin: async () => false },
      decisions: { record: async () => {} },
    }),
    store: {
      open: async () => open,
      close: async (input) => {
        closed.push(input);
        // What the store does: the named ones leave the open list.
        open = open.filter((notice) => !input.ids.includes(notice.id));
      },
    },
  });
  return { admin, closed };
}

const refused = (run: Promise<unknown>) =>
  run.then(
    () => "allowed",
    (error: unknown) =>
      error instanceof SessionServiceError ? error.code : String(error),
  );

test("owners and admins read the open notices, each with its session count", async () => {
  const forgottenAt = new Date("2026-11-24T09:12:44.000Z");
  const { admin } = setup([{ id: NOTICE, forgottenAt, sessions: 3 }]);
  for (const role of ["owner", "admin"] as const) {
    expect(await admin.read(person(role))).toEqual({
      notices: [
        { id: NOTICE, forgotten_at: "2026-11-24T09:12:44.000Z", sessions: 3 },
      ],
    });
  }
});

test("a member and an API key neither read nor close, and the store is not asked", async () => {
  const { admin, closed } = setup([
    { id: NOTICE, forgottenAt: new Date(), sessions: 1 },
  ]);
  for (const caller of [person("member"), apiKey]) {
    expect(await refused(admin.read(caller))).toBe("FORBIDDEN");
    expect(await refused(admin.close(caller, { ids: [NOTICE] }))).toBe(
      "FORBIDDEN",
    );
  }
  expect(closed).toEqual([]);
});

test("closing records who closed and answers what is still open", async () => {
  const forgottenAt = new Date("2026-11-24T09:30:00.000Z");
  const { admin, closed } = setup([
    { id: NOTICE, forgottenAt: new Date(), sessions: 2 },
    // A start after the administrator read the list: not among the ids.
    { id: LATER, forgottenAt, sessions: 1 },
  ]);
  const closer = person("admin");
  expect(await admin.close(closer, { ids: [NOTICE] })).toEqual({
    notices: [
      { id: LATER, forgotten_at: "2026-11-24T09:30:00.000Z", sessions: 1 },
    ],
  });
  expect(closed).toEqual([
    { ids: [NOTICE], closedBy: closer.actor?.userId as string },
  ]);
});
