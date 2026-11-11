import type {
  SlackNoticeRecord,
  SlackNoticeSink,
} from "../slack-notice-sink.ts";

export * from "./slack-store-fakes.ts";

/**
 * Keeps one notice per `onceKey`, as the outbox delivery does: a person who
 * keeps writing into a thread they may not use hears about it once.
 */
export function createMemorySlackNoticeSink() {
  const notices: SlackNoticeRecord[] = [];
  const sink: SlackNoticeSink = {
    async record(notice) {
      if (notices.some((held) => held.onceKey === notice.onceKey)) return;
      notices.push(notice);
    },
  };
  return { sink, notices };
}
