// Fixtures shared by the ingest tests: an OTLP/JSON batch builder and in-memory ports.

import { turnTraceId } from "@werft-ai/observability";
import type {
  AttemptAuthenticator,
  DropCounter,
  DropReason,
  IngestAttempt,
  SpanSink,
  TurnTraceDirectory,
} from "../ingest/ports.ts";

export const SESSION = "00000000-0000-4000-8000-000000000001";
export const TURN_TRACE = turnTraceId(SESSION, 1);

type Attr = [string, string | number | boolean];

function otlpAttributes(attributes: readonly Attr[]) {
  return attributes.map(([key, value]) => ({
    key,
    value:
      typeof value === "string"
        ? { stringValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : { intValue: String(value) },
  }));
}

export interface SpanInput {
  traceId?: string;
  spanId?: string;
  name?: string;
  attributes?: Attr[];
  eventAttributes?: Attr[];
  linkAttributes?: Attr[];
  resource?: Attr[];
  statusMessage?: string;
}

let counter = 0;

export function batch(...spans: SpanInput[]): string {
  const resource = spans[0]?.resource ?? [];
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: otlpAttributes(resource) },
        scopeSpans: [
          {
            scope: { name: "worker", version: "1" },
            spans: spans.map((s) => {
              counter += 1;
              return {
                traceId: s.traceId ?? TURN_TRACE,
                spanId: s.spanId ?? counter.toString(16).padStart(16, "0"),
                name: s.name ?? "werft.tool",
                kind: 1,
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000001000000000",
                attributes: otlpAttributes(s.attributes ?? []),
                events: [
                  {
                    name: "event",
                    timeUnixNano: "1700000000500000000",
                    attributes: otlpAttributes(s.eventAttributes ?? []),
                  },
                ],
                links: [
                  {
                    traceId: TURN_TRACE,
                    spanId: "00000000000000ff",
                    attributes: otlpAttributes(s.linkAttributes ?? []),
                  },
                ],
                status:
                  s.statusMessage === undefined
                    ? { code: 0 }
                    : { code: 2, message: s.statusMessage },
              };
            }),
          },
        ],
      },
    ],
  });
}

export function attemptOf(
  overrides: Partial<IngestAttempt> = {},
): IngestAttempt {
  return {
    sessionId: SESSION,
    attemptId: "att_1",
    executionId: "exe_1",
    executionGeneration: 3,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    fence: { state: "held" },
    ...overrides,
  };
}

export function authenticatorOf(
  tokens: Record<string, IngestAttempt>,
): AttemptAuthenticator {
  return { authenticate: async (token) => tokens[token] ?? null };
}

export function turnsOf(traceIds: readonly string[]): TurnTraceDirectory {
  return { traceIdsOf: async () => new Set(traceIds) };
}

export class RecordingSink implements SpanSink {
  readonly sent: Awaited<Parameters<SpanSink["send"]>[0]>[number][] = [];
  async send(spans: Parameters<SpanSink["send"]>[0]) {
    this.sent.push(...spans);
  }
}

export class CountingDrops implements DropCounter {
  readonly counts: Partial<Record<DropReason, number>> = {};
  dropped(reason: DropReason, count: number) {
    this.counts[reason] = (this.counts[reason] ?? 0) + count;
  }
}

export function post(
  body: string,
  token = "tok",
  headers: Record<string, string> = {},
): Request {
  return new Request("http://ingest.test/v1/traces", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}
