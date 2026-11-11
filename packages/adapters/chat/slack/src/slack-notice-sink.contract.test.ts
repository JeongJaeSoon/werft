import { describe, expect, test } from "bun:test";
import type { SlackOutboxEntry, SlackOutboxStore } from "@werft-ai/platform";
import type {
  SlackNoticeRecord,
  SlackNoticeSink,
} from "./slack-notice-sink.ts";
import { createOutboxSlackNoticeSink } from "./slack-outbox-enqueue.ts";
import { createMemorySlackNoticeSink } from "./testing/slack-fakes.ts";

// `SlackNoticeSink` is the Slack adapter's own seam (the function that puts a
// refusal notice in front of the person who typed), so its contract lives in
// the adapter rather than in platform's `./testing/*`. It runs against the
// outbox implementation and against the in-memory fake the other tests use:
// a fake that keeps a notice the real sink would drop makes the tests above
// it pass for the wrong reason.
type NoticeSinkSubject = {
  sink: SlackNoticeSink;
  /** What will reach a reader, in the order recorded. */
  delivered(): { channelId: string; threadTs: string; slackUserId: string }[];
};

const notice = (
  slackUserId: string,
  threadTs = "100.000100",
): SlackNoticeRecord => ({
  workspaceId: "ws-1",
  agentId: "agent-1",
  installationId: "installation-1",
  slackAppId: "slack-app-1",
  teamId: "T0ACME",
  channelId: "C0OPS",
  threadTs,
  slackUserId,
  reason: "unlinked",
  notice: { message: "connect", link_url: "https://console.example/l" },
  onceKey: `installation-1:C0OPS:${threadTs}:${slackUserId}`,
});

function describeSlackNoticeSinkContract(
  name: string,
  make: () => NoticeSinkSubject,
) {
  describe(name, () => {
    test("tells the person who typed, alone, where they typed", async () => {
      const { sink, delivered } = make();
      await sink.record(notice("U0A"));
      expect(delivered()).toEqual([
        { channelId: "C0OPS", threadTs: "100.000100", slackUserId: "U0A" },
      ]);
    });

    test("tells the same person once in a thread, however often they write", async () => {
      const { sink, delivered } = make();
      await sink.record(notice("U0A"));
      await sink.record(notice("U0A"));
      await sink.record(notice("U0A"));
      expect(delivered().map((entry) => entry.slackUserId)).toEqual(["U0A"]);
    });

    test("tells another person on their own, and the same person again in another thread", async () => {
      const { sink, delivered } = make();
      await sink.record(notice("U0A"));
      await sink.record(notice("U0A"));
      await sink.record(notice("U0B"));
      await sink.record(notice("U0A", "200.000200"));
      expect(
        delivered().map((entry) => `${entry.slackUserId}@${entry.threadTs}`),
      ).toEqual(["U0A@100.000100", "U0B@100.000100", "U0A@200.000200"]);
    });
  });
}

/**
 * An outbox that keeps a row per dedupe key, as the store's port says: the
 * same key twice enqueues once.
 */
function memoryOutbox() {
  const rows = new Map<string, SlackOutboxEntry>();
  const outbox: Pick<SlackOutboxStore, "enqueue" | "readerLocale"> = {
    async enqueue(entry) {
      if (rows.has(entry.dedupeKey)) return "duplicate";
      rows.set(entry.dedupeKey, entry);
      return "enqueued";
    },
    async readerLocale() {
      return null;
    },
  };
  return { outbox, rows };
}

describeSlackNoticeSinkContract("the outbox notice sink", () => {
  const { outbox, rows } = memoryOutbox();
  return {
    sink: createOutboxSlackNoticeSink(outbox),
    delivered: () =>
      [...rows.values()]
        .filter((row) => row.kind === "notice")
        .map((row) => ({
          channelId: row.channelId,
          threadTs: row.threadTs,
          slackUserId: row.slackUserId ?? "",
        })),
  };
});

describeSlackNoticeSinkContract("the in-memory notice sink", () => {
  const { sink, notices } = createMemorySlackNoticeSink();
  return {
    sink,
    delivered: () =>
      notices.map((held) => ({
        channelId: held.channelId,
        threadTs: held.threadTs,
        slackUserId: held.slackUserId,
      })),
  };
});
