import type {
  SessionDetail as SessionDetailData,
  SessionSummary,
  SessionUsageResponse,
} from "@werft-ai/contracts";
import { ErrorState, Skeleton } from "@werft-ai/ui";

import { json } from "../../.storybook/fake-client.ts";
import { SESSION, TURN_EVENTS } from "../domain/session/session-fixtures.ts";

// The host's own words, which the blocks take as props. The toolbar's
// Language switches them along with the blocks' catalog.
const HOST = {
  ko: {
    loading: "불러오는 중",
    failed: "불러오지 못했습니다.",
    retry: "다시 시도",
    recent: "최근 세션",
    waiting: "대기 세션",
    unavailable: {
      answer: "세션 승인 권한이 있어야 답할 수 있습니다.",
      control: "세션 제어 권한이 있어야 할 수 있습니다.",
      send: "메시지 보내기 권한이 있어야 할 수 있습니다.",
    },
  },
  ja: {
    loading: "読み込み中",
    failed: "読み込めませんでした。",
    retry: "再試行",
    recent: "最近のセッション",
    waiting: "待機中のセッション",
    unavailable: {
      answer: "回答するには sessions:approve の権限が必要です。",
      control: "この操作には sessions:control の権限が必要です。",
      send: "この操作には sessions:write の権限が必要です。",
    },
  },
  en: {
    loading: "Loading",
    failed: "The read failed.",
    retry: "Retry",
    recent: "Recent sessions",
    waiting: "Waiting sessions",
    unavailable: {
      answer: "You need the sessions:approve permission for this.",
      control: "You need the sessions:control permission for this.",
      send: "You need the sessions:write permission for this.",
    },
  },
};

type Host = (typeof HOST)["ko"];
export type Globals = { readonly globals: { readonly locale?: string } };

export const hostFor = ({ globals }: Globals): Host =>
  globals.locale === "en" || globals.locale === "ja"
    ? HOST[globals.locale]
    : HOST.ko;

export const shared = (host: Host) => ({
  loading: <Skeleton lines={3} label={host.loading} />,
  renderError: (_error: unknown, retry: () => void) => (
    <ErrorState message={host.failed} retry={retry} retryLabel={host.retry} />
  ),
});

export const page = (items: unknown[], next_cursor: string | null = null) =>
  json(200, { items, next_cursor });

/** A request that never answers, so the block stays in its loading state. */
export const pending = () => new Promise<Response>(() => {});

export const SESSIONS: SessionSummary[] = [
  SESSION,
  {
    ...SESSION,
    id: "0192f0c4-7d3a-7b4e-9f00-0000000000a2",
    status: "needs_input",
  },
  {
    ...SESSION,
    id: "0192f0c4-7d3a-7b4e-9f00-0000000000a3",
    status: "failed",
    admission_state: "recovery_required",
    queued_turn_count: 0,
  },
];

/** What `GET /v1/sessions?status=needs_input` answers. */
export const WAITING: SessionSummary[] = [
  { ...SESSION, status: "needs_input" },
  {
    ...SESSION,
    id: "0192f0c4-7d3a-7b4e-9f00-0000000000a2",
    status: "needs_input",
  },
];

export const DETAIL: SessionDetailData = {
  ...SESSION,
  status: "needs_input",
  execution: null,
  checkpoint_revision: null,
  pending_request_count: 1,
  attention: null,
  durability: {
    last_transcript_persisted_at: null,
    checkpoint_committed_at: null,
    checkpoint_revision: null,
    last_completed_turn_id: null,
    last_checkpointed_turn_id: null,
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
} as SessionDetailData;

export const USAGE: SessionUsageResponse = {
  session_id: SESSION.id,
  period: "session_lifetime",
  refreshed_at: SESSION.updated_at,
  cost: {
    amount_usd: "0.4200",
    kind: "estimated",
    source: "provider_usage",
    completeness_scope: "turn_reports",
    complete: false,
    reported_turn_count: 1,
    unreported_turn_count: 0,
    open_turn_count: 1,
  },
  cost_limit_usd: "5",
  token_count: 1540,
  token_limit: null,
  budget_exceeded: false,
  queued_input_count: 0,
  queued_input_limit: 10,
};

export function eventStream(): Response {
  return eventStreamOf(TURN_EVENTS);
}

/**
 * These events as the API streams them, in turn `turn_1` unless an event
 * names its own; each `stepMs` after the one before, ending at the session's
 * last update.
 */
export function eventStreamOf(
  events: readonly (readonly [string, unknown, (string | null)?])[],
  stepMs = 0,
): Response {
  const encoder = new TextEncoder();
  const end = Date.parse(SESSION.updated_at);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      events.forEach(([event, data, turnId = "turn_1"], index) => {
        const envelope = {
          schema_version: 1,
          session_id: SESSION.id,
          turn_id: turnId,
          attempt_id: null,
          occurred_at: new Date(
            end - (events.length - 1 - index) * stepMs,
          ).toISOString(),
          data,
        };
        controller.enqueue(
          encoder.encode(
            `id: ev_${index}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`,
          ),
        );
      });
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

export const base = `/v1/sessions/${SESSION.id}`;
// Far enough ahead that the requests still take answers.
const OPEN_UNTIL = "2099-01-01T00:00:00.000Z";
export const accepted = () =>
  json(202, {
    receipt_id: "0192f0c4-7d3a-7b4e-9f00-0000000000f1",
    receipt_status: "accepted",
  });

export const PENDING = {
  answerable: true,
  items: [
    {
      kind: "permission",
      request_id: "req_1",
      turn_id: "turn_1",
      attempt_id: "att_1",
      created_at: SESSION.updated_at,
      expires_at: OPEN_UNTIL,
      tool: "Bash",
      input: { command: "bun test" },
    },
    {
      kind: "question",
      request_id: "req_2",
      turn_id: "turn_1",
      attempt_id: "att_1",
      created_at: SESSION.updated_at,
      expires_at: OPEN_UNTIL,
      questions: [
        {
          question_id: "q_1",
          // What the agent asks is in its own language, not the catalog's;
          // long Korean here checks the card's wrapping (v2 V:467).
          prompt:
            "결제 실패 알림을 고친 커밋을 어느 브랜치에 올릴까요? 릴리스 브랜치에 올리면 다음 패치 배포에 함께 나가고, main에만 올리면 다음 정기 배포까지 기다립니다.",
          options: [
            { option_id: "main", label: "main에만 올리기" },
            { option_id: "release", label: "release/1.4에도 함께 올리기" },
          ],
          multi_select: false,
          allow_free_text: true,
        },
      ],
    },
  ],
};
