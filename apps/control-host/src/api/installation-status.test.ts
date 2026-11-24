import { expect, test } from "bun:test";
import { type Principal, scopesForRole } from "@werft-ai/contracts";
import {
  callerFor,
  createAuthorizationPolicy,
  SessionServiceError,
} from "@werft-ai/platform";
import {
  createInstallationStatusReader,
  noDiskQuotaFromEnv,
  noDiskQuotaWarning,
} from "./installation-status.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";

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

const reader = createInstallationStatusReader({
  authorization: createAuthorizationPolicy({
    agents: { agentOf: async () => null, isAdmin: async () => false },
    decisions: { record: async () => {} },
  }),
  status: { profile: "test", no_disk_quota: true },
});

const outcome = (run: Promise<unknown>) =>
  run.then(
    () => "allowed",
    (error: unknown) =>
      error instanceof SessionServiceError ? error.code : String(error),
  );

test("owners and admins read the status; a member and an API key do not", async () => {
  for (const role of ["owner", "admin"] as const)
    expect(await reader.read(person(role))).toEqual({
      profile: "test",
      no_disk_quota: true,
    });
  expect(await outcome(reader.read(person("member")))).toBe("FORBIDDEN");
  expect(await outcome(reader.read(apiKey))).toBe("FORBIDDEN");
});

test("only the exact off the scheduler accepts means no disk quota", () => {
  expect(noDiskQuotaFromEnv({ EXECUTION_WORKSPACE_QUOTA: "off" })).toBe(true);
  for (const value of [undefined, "on", "", "OFF"])
    expect(noDiskQuotaFromEnv({ EXECUTION_WORKSPACE_QUOTA: value })).toBe(
      false,
    );
});

test("the start-time warning says not for production on a test installation", () => {
  expect(noDiskQuotaWarning("test")).toContain("not for production");
  expect(noDiskQuotaWarning("production")).toContain("Turn the XFS quota on");
});
