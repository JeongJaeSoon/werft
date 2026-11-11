import { expect, test } from "bun:test";
import { readArchivedWorkspaceLimit } from "./workspace-limit.ts";

const attempt = { id: "latest", startedAt: new Date("2026-11-06T00:00:00Z") };
const chunk = (lastCreatedAt = attempt.startedAt) => ({
  fromId: 1,
  throughId: 2,
  objectKey: "archive",
  versionId: "v1",
  sha256: "a".repeat(64),
  eventCount: 2,
  lastCreatedAt,
});

test("missing storage and failed or corrupt storage leave optional diagnostics absent", async () => {
  expect(
    await readArchivedWorkspaceLimit(undefined, [chunk()], attempt),
  ).toBeUndefined();
  expect(
    await readArchivedWorkspaceLimit(
      {
        lines: async () => {
          throw new Error("unavailable");
        },
      },
      [chunk()],
      attempt,
    ),
  ).toBeUndefined();
  expect(
    await readArchivedWorkspaceLimit(
      { lines: async () => [{ id: 1, line: "corrupt" }] },
      [chunk()],
      attempt,
    ),
  ).toBeUndefined();
});

test("an unclassified latest attempt never downloads earlier attempts' chunks", async () => {
  let downloads = 0;
  const archive = {
    lines: async () => {
      downloads++;
      return [];
    },
  };
  expect(
    await readArchivedWorkspaceLimit(
      archive,
      [chunk(new Date("2026-11-05T23:59:59Z"))],
      attempt,
    ),
  ).toBeUndefined();
  expect(downloads).toBe(0);
});

test("only the matching attempt's latest valid system classification is read", async () => {
  const mode = {
    bytes: "hard",
    inodes: "unknown",
    reason: "storage_declaration_and_capacity",
  } as const;
  const archive = {
    lines: async () => [
      {
        id: 1,
        line: JSON.stringify({
          type: "system",
          attempt_id: "latest",
          payload: { type: "system", subtype: "workspace_limit_mode", ...mode },
        }),
      },
      {
        id: 2,
        line: JSON.stringify({
          type: "system",
          attempt_id: "other",
          payload: {
            subtype: "workspace_limit_mode",
            bytes: "soft",
            inodes: "soft",
          },
        }),
      },
    ],
  };
  expect(await readArchivedWorkspaceLimit(archive, [chunk()], attempt)).toEqual(
    mode,
  );
});
