import type {
  SlackNoticeRecord,
  SlackNoticeSink,
  SlackThreadNoticeRecord,
} from "../slack-notice-sink.ts";

export * from "./slack-store-fakes.ts";

/**
 * Keeps one notice per `onceKey`, as the outbox delivery does: a person who
 * keeps writing into a thread they may not use hears about it once.
 */
export function createMemorySlackNoticeSink() {
  const notices: SlackNoticeRecord[] = [];
  const threadNotices: SlackThreadNoticeRecord[] = [];
  const sink: SlackNoticeSink = {
    async record(notice) {
      if (notices.some((held) => held.onceKey === notice.onceKey)) return;
      notices.push(notice);
    },
    async recordInThread(notice) {
      if (threadNotices.some((held) => held.onceKey === notice.onceKey)) {
        return;
      }
      threadNotices.push(notice);
    },
  };
  return { sink, notices, threadNotices };
}
