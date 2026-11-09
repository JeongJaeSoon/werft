import { describe, expect, test } from "bun:test";
import type { PushSourceResult } from "../checkpoints/checkpoint-service.ts";
import { pushApprovability } from "./push-approvability.ts";

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const session = (checkpointRevision: number | null) => ({
  id: "11111111-1111-4111-8111-111111111111",
  checkpointRevision,
});
const request = (
  state: "requested" | "approved" | "rejected" = "requested",
  checkpointRevision = 3,
) => ({ state, checkpointRevision, gitCommit: COMMIT });
const source = (read: () => Promise<PushSourceResult>) => ({
  readPushSource: read,
  readPushSourceAt: read,
});

describe("pushApprovability", () => {
  test("a decided request is not approvable", async () => {
    for (const state of ["approved", "rejected"] as const) {
      expect(await pushApprovability(session(3), request(state))).toEqual({
        approvable: false,
        reason: "not_requested",
      });
    }
  });

  test("the request's own revision is approvable without reading anything", async () => {
    let reads = 0;
    const verdict = await pushApprovability(
      session(3),
      request(),
      source(async () => {
        reads += 1;
        return { status: "none" };
      }),
    );
    expect(verdict).toEqual({ approvable: true });
    expect(reads).toBe(0);
  });

  test("another revision of the same commit is approvable", async () => {
    const verdict = await pushApprovability(
      session(4),
      request(),
      source(async () => ({ status: "ready", revision: 4, gitCommit: COMMIT })),
    );
    expect(verdict).toEqual({ approvable: true });
  });

  test("another revision of another commit is checkpoint_moved", async () => {
    const verdict = await pushApprovability(
      session(4),
      request(),
      source(async () => ({ status: "ready", revision: 4, gitCommit: OTHER })),
    );
    expect(verdict).toEqual({ approvable: false, reason: "checkpoint_moved" });
  });

  test("a manifest that cannot be read leaves the revision rule alone", async () => {
    for (const read of [
      async (): Promise<PushSourceResult> => ({
        status: "unavailable",
        reason: "x",
      }),
      async (): Promise<PushSourceResult> => ({ status: "none" }),
      async (): Promise<PushSourceResult> => {
        throw new Error("store down");
      },
    ]) {
      expect(
        await pushApprovability(session(4), request(), source(read)),
      ).toEqual({ approvable: false, reason: "checkpoint_moved" });
    }
  });

  test("a pointer that moved during the read answers as the server would", async () => {
    // Read at revision 5 while the session row said 4: the server's FOR
    // SHARE check would find the pointer moved past what it was told.
    const verdict = await pushApprovability(
      session(4),
      request(),
      source(async () => ({ status: "ready", revision: 5, gitCommit: COMMIT })),
    );
    expect(verdict).toEqual({ approvable: false, reason: "checkpoint_moved" });
  });

  test("without a source a moved revision counts as approvable", async () => {
    expect(await pushApprovability(session(4), request())).toEqual({
      approvable: true,
    });
    expect(await pushApprovability(session(null), request())).toEqual({
      approvable: true,
    });
    expect(await pushApprovability(session(4), request("approved"))).toEqual({
      approvable: false,
      reason: "not_requested",
    });
  });

  describe("an intent request pinned to its turn's revision", () => {
    const intent = { ...request(), origin: "intent" as const };

    test("is approvable after the pointer moved, while the pinned revision verifies", async () => {
      let readAt: number | undefined;
      const verdict = await pushApprovability(session(9), intent, {
        readPushSource: async () => ({ status: "none" }),
        readPushSourceAt: async (_id, revision) => {
          readAt = revision;
          return { status: "ready", revision, gitCommit: COMMIT };
        },
      });
      expect(verdict).toEqual({ approvable: true });
      expect(readAt).toBe(3);
    });

    test("is pinned_source_invalid when that revision is gone or carries another commit", async () => {
      for (const read of [
        async (): Promise<PushSourceResult> => ({ status: "none" }),
        async (): Promise<PushSourceResult> => ({
          status: "ready",
          revision: 3,
          gitCommit: OTHER,
        }),
      ]) {
        expect(
          await pushApprovability(session(9), intent, source(read)),
        ).toEqual({
          approvable: false,
          reason: "pinned_source_invalid",
        });
      }
    });

    test("without a source it stays approvable, as a moved direct request does", async () => {
      expect(await pushApprovability(session(9), intent)).toEqual({
        approvable: true,
      });
    });

    test("is approvable on a kept branch's commit that is not the snapshot, and not on a commit no branch holds", async () => {
      const pinned = (gitCommit: string, kept: string[]) =>
        source(async () => ({
          status: "ready",
          revision: 3,
          gitCommit,
          sources: kept.map((commit, at) => ({ name: `b${at}`, commit })),
        }));
      expect(
        await pushApprovability(
          session(9),
          intent,
          pinned(OTHER, [OTHER, COMMIT]),
        ),
      ).toEqual({ approvable: true });
      expect(
        await pushApprovability(session(9), intent, pinned(OTHER, [OTHER])),
      ).toEqual({ approvable: false, reason: "pinned_source_invalid" });
    });
  });
});
