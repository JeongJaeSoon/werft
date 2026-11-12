import type { ApiErrorCode } from "@werft-ai/contracts";
import type { ContractMismatch } from "./contract.ts";

export type ClientErrorCode =
  | ApiErrorCode
  | "NETWORK_ERROR"
  | "UNKNOWN"
  | "CLIENT_CONTRACT_MISMATCH";

export interface ApiErrorDetail {
  readonly requestId?: string | null;
  /** The server's `error.retryable`; null when it did not say. */
  readonly retryable?: boolean | null;
  /** The server's `error.details`, as sent. */
  readonly details?: unknown;
  /** From a `Retry-After` header in seconds. */
  readonly retryAfterSeconds?: number | null;
  /** Set only for CLIENT_CONTRACT_MISMATCH. */
  readonly mismatch?: ContractMismatch | null;
}

/**
 * What every failed call becomes. Callers branch on `code` (the server's
 * `error.code`), never on the HTTP status alone, and show `message` as the
 * server wrote it — a 403 says which scope was missing.
 */
export class ApiError extends Error {
  readonly requestId: string | null;
  readonly retryable: boolean | null;
  readonly details: unknown;
  readonly retryAfterSeconds: number | null;
  readonly mismatch: ContractMismatch | null;

  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    detail: ApiErrorDetail = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.requestId = detail.requestId ?? null;
    this.retryable = detail.retryable ?? null;
    this.details = detail.details ?? null;
    this.retryAfterSeconds = detail.retryAfterSeconds ?? null;
    this.mismatch = detail.mismatch ?? null;
  }
}

interface ErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    request_id?: unknown;
    retryable?: unknown;
    details?: unknown;
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Seconds from a `Retry-After` header; an HTTP date or junk reads as none. */
export function retryAfterSeconds(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after") ?? Number.NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** A non-2xx response and its parsed body, as one error shape. */
export function errorFromResponse(response: Response, body: unknown): ApiError {
  // The body is whatever answered, a proxy's page included; only a field of
  // the right type is taken from it.
  const error = (body as ErrorBody | null | undefined)?.error;
  return new ApiError(
    response.status,
    (text(error?.code) as ApiErrorCode | undefined) ?? "UNKNOWN",
    text(error?.message) ?? response.statusText,
    {
      requestId:
        text(error?.request_id) ?? response.headers.get("x-request-id"),
      retryable: typeof error?.retryable === "boolean" ? error.retryable : null,
      details: error?.details ?? null,
      retryAfterSeconds: retryAfterSeconds(response),
    },
  );
}

function networkError(cause: unknown): ApiError {
  return new ApiError(
    0,
    "NETWORK_ERROR",
    cause instanceof Error ? cause.message : String(cause),
  );
}

/**
 * The data of a successful call, or an ApiError. Every query and mutation
 * goes through this so a screen sees one error shape.
 */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let result: Awaited<typeof call>;
  try {
    result = await call;
  } catch (cause) {
    // A strict contract check throws from inside the call.
    if (cause instanceof ApiError) throw cause;
    throw networkError(cause);
  }
  const { data, error, response } = result;
  if (response.ok) return data as T;
  throw errorFromResponse(response, error);
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return (
    error instanceof ApiError && (code === undefined || error.code === code)
  );
}
