import { expect, test } from "bun:test";
import {
  type InstallationConfigEntries,
  type Principal,
  scopesForRole,
} from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "@werft-ai/platform";
import type { InstallationConfigSource } from "../wiring/installation-config.ts";
import type { CheckpointStorageConfig } from "./checkpoints.ts";
import {
  createInstallationConfigAdmin,
  sessionArchiveStatusOf,
} from "./installation-config.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";

const storage = (protection: "locked" | "unversioned") =>
  ({ protection }) as CheckpointStorageConfig;

test("archiving is available only where the object store holds versions", () => {
  expect(sessionArchiveStatusOf("disabled")).toEqual({
    available: false,
    reason: "object_store_disabled",
  });
  expect(sessionArchiveStatusOf(storage("unversioned"))).toEqual({
    available: false,
    reason: "unversioned",
  });
  expect(sessionArchiveStatusOf(storage("locked"))).toEqual({
    available: true,
    reason: null,
  });
});

test("both the read and the save answer whether this deployment can archive", async () => {
  const status = { available: false, reason: "unversioned" } as const;
  const admin = createInstallationConfigAdmin({
    authorization: createAuthorizationPolicy({
      agents: { agentOf: async () => null, isAdmin: async () => false },
      decisions: { record: async () => {} },
    }),
    source: {
      view: async () => ({}) as InstallationConfigEntries,
    } as InstallationConfigSource,
    store: { setValues: async () => ({ changed: true }) },
    sessionArchive: status,
  });
  const principal: Principal = {
    kind: "user",
    id: "019a0000-0000-7000-8000-0000000000c1",
    workspace_id: WORKSPACE,
    role: "owner",
    scopes: [...scopesForRole("owner")],
  };
  const owner = callerFor(principal, { kind: "web" }, crypto.randomUUID());
  expect((await admin.read(owner)).session_archive).toEqual(status);
  const saved = await admin.change(owner, { session_archive_dry_run: false });
  expect(saved.session_archive).toEqual(status);
  expect(saved.receipt_id).toBeString();
});
