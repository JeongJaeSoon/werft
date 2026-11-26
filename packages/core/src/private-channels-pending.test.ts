import { describe, expect, test } from "bun:test";
import type { ApiClient } from "@werft-ai/client";
import {
  PRIVATE_CHANNELS_PENDING_REFETCH_MS,
  privateChannelsPending,
  refetchWhilePending,
  withQueryScope,
} from "./index.ts";
import { waitingSessionsQuery } from "./queries.ts";

const at = (data: unknown) => ({ state: { data } });

// 94S-2270: a list that left out private channels still being confirmed is
// read again soon, and only while it says so.
describe("reading a list again while private channels are confirmed", () => {
  test("an answer, or any page of a paged one, can say pending", () => {
    expect(privateChannelsPending({ private_channels_pending: true })).toBe(
      true,
    );
    expect(
      privateChannelsPending({
        pages: [{ items: [] }, { items: [], private_channels_pending: true }],
      }),
    ).toBe(true);
    for (const data of [undefined, null, { items: [] }, { pages: [{}] }]) {
      expect(privateChannelsPending(data)).toBe(false);
    }
  });

  test("pending reads again at the pending pace, else at the query's own", () => {
    const pending = at({ private_channels_pending: true });
    expect(refetchWhilePending()(pending)).toBe(
      PRIVATE_CHANNELS_PENDING_REFETCH_MS,
    );
    expect(refetchWhilePending()(at({ items: [] }))).toBe(false);
    expect(refetchWhilePending(30_000)(pending)).toBe(
      PRIVATE_CHANNELS_PENDING_REFETCH_MS,
    );
    expect(refetchWhilePending(30_000)(at(undefined))).toBe(30_000);
    expect(refetchWhilePending(1_000)(pending)).toBe(1_000);
  });

  test("the waiting list keeps its 30 s pace when nothing is pending", () => {
    const client = withQueryScope({} as ApiClient, {
      actor: "user:u-1",
      workspace: "w-1",
    });
    const { refetchInterval } = waitingSessionsQuery(client) as unknown as {
      refetchInterval: (query: { state: { data: unknown } }) => unknown;
    };
    expect(refetchInterval(at({ items: [] }))).toBe(30_000);
    expect(
      refetchInterval(at({ items: [], private_channels_pending: true })),
    ).toBe(PRIVATE_CHANNELS_PENDING_REFETCH_MS);
  });
});
