import { AsyncLocalStorage } from "node:async_hooks";

import { type LogFields, sanitizeFields, sanitizeText } from "./redaction.ts";
import { currentSpanContext } from "./tracing/tracer.ts";

export {
  type LogFields,
  REDACTED,
  sanitizeFields,
  sanitizeText,
} from "./redaction.ts";
export {
  type ContentMode,
  parseTracingSettings,
  type SamplerKind,
  type TracingSettings,
} from "./tracing/config.ts";
export { isContentAttribute } from "./tracing/content-attributes.ts";
export type {
  IngestAttributes,
  IngestAttributeValue,
  IngestSpan,
  IngestSpanEvent,
  IngestSpanLink,
} from "./tracing/ingest-span.ts";
export {
  type ClaimTelemetry,
  createTelemetryPolicy,
  effectiveContentMode,
  endpointOnEgressAllowlist,
  type TelemetryPolicy,
} from "./tracing/telemetry-policy.ts";
export { turnTraceId } from "./tracing/trace-id.ts";
export {
  currentSpanContext,
  formatTraceparent,
  noopTracer,
  parseTraceparent,
  type Span,
  type SpanAttributeValue,
  type SpanContext,
  type StartSpanOptions,
  sampleByTraceId,
  type Tracer,
} from "./tracing/tracer.ts";

/** The two keys belong to the active span, so a hand-set context value never survives. */
function contextWithoutSpanKeys(
  context: ObservabilityContext,
): ObservabilityContext {
  const { trace_id: _trace, span_id: _span, ...rest } = context;
  return rest;
}

/** `trace_id`/`span_id` of the active span; no keys at all outside a span. */
function spanLogFields(): { trace_id?: string; span_id?: string } {
  const span = currentSpanContext();
  return span ? { trace_id: span.traceId, span_id: span.spanId } : {};
}

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ObservabilityContext {
  readonly session_id?: string;
  readonly turn_id?: string | number;
  readonly pod_id?: string;
  readonly request_id?: string;
  readonly trace_id?: string;
  readonly span_id?: string;
}

export interface LogRecord extends ObservabilityContext {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event?: string;
  readonly message: string;
  readonly fields?: LogFields;
}

export interface LogSink {
  write(record: LogRecord): void | Promise<void>;
}

export interface LoggerOptions {
  readonly level?: LogLevel | string;
  readonly sinks?: readonly LogSink[];
  readonly includeMessageBodies?: boolean;
  readonly now?: () => Date;
}

const levelRank: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isLogLevel(value: string | undefined): value is LogLevel {
  return (
    value !== undefined && (LOG_LEVELS as readonly string[]).includes(value)
  );
}

export function resolveLogLevel(value = process.env.LOG_LEVEL): LogLevel {
  // Trimmed like logLevelFromEnv, so a level that passed startup is the one
  // the logger runs at.
  const normalized = value?.trim().toLowerCase();
  return isLogLevel(normalized) ? normalized : "info";
}

/**
 * LOG_LEVEL as a process takes it at startup: unset or empty is `info`, and a
 * value that names no level stops the process instead of quietly logging at
 * `info`.
 */
export function logLevelFromEnv(value: string | undefined): LogLevel {
  if (value === undefined || value.trim() === "") return "info";
  const normalized = value.trim().toLowerCase();
  if (!isLogLevel(normalized)) {
    throw new Error(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join("|")}, got ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}

export class MemoryLogSink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

export class StdoutLogSink implements LogSink {
  write(record: LogRecord): void {
    console.log(JSON.stringify(record));
  }
}

export class StructuredLogger {
  private readonly context = new AsyncLocalStorage<ObservabilityContext>();
  private readonly includeMessageBodies: boolean;
  private readonly level: LogLevel;
  private readonly now: () => Date;
  private readonly sinks: readonly LogSink[];

  constructor(options: LoggerOptions = {}) {
    this.level = resolveLogLevel(options.level);
    this.sinks = options.sinks ?? [new StdoutLogSink()];
    this.includeMessageBodies = options.includeMessageBodies ?? false;
    this.now = options.now ?? (() => new Date());
  }

  getContext(): ObservabilityContext {
    return this.context.getStore() ?? {};
  }

  withContext<T>(context: ObservabilityContext, run: () => T): T {
    return this.context.run({ ...this.getContext(), ...context }, run);
  }

  debug(message: string, fields?: LogFields): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.log("error", message, fields);
  }

  log(level: LogLevel, message: string, fields?: LogFields): void {
    if (levelRank[level] < levelRank[this.level]) {
      return;
    }

    let record: LogRecord;
    try {
      const sanitizedFields = fields
        ? sanitizeFields(fields, this.includeMessageBodies)
        : undefined;
      const event =
        typeof sanitizedFields?.event === "string"
          ? sanitizedFields.event
          : undefined;
      const recordFields =
        event === undefined
          ? sanitizedFields
          : Object.fromEntries(
              Object.entries(sanitizedFields ?? {}).filter(
                ([key]) => key !== "event",
              ),
            );
      record = {
        timestamp: this.now().toISOString(),
        level,
        ...(event === undefined ? {} : { event }),
        message: sanitizeText(message),
        ...contextWithoutSpanKeys(this.getContext()),
        // Read when the line is written: the active span changes inside one request.
        ...spanLogFields(),
        ...(recordFields && Object.keys(recordFields).length > 0
          ? { fields: recordFields }
          : {}),
      };
    } catch {
      return;
    }

    for (const sink of this.sinks) {
      try {
        const result = sink.write(record);
        if (result instanceof Promise) {
          void result.catch(() => undefined);
        }
      } catch {
        // Logging must never make a worker or API request fail.
      }
    }
  }
}

export function createLogger(options: LoggerOptions = {}): StructuredLogger {
  return new StructuredLogger(options);
}
