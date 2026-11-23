/** One request control-host sends a server itself, under the outbound policy. */
export type OutboundRequest = {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** The whole request's deadline; the implementation's own when absent. */
  timeoutMs?: number;
};
export type OutboundResponse = {
  status: number;
  headers: Headers;
  text: string;
};
/**
 * Throws OutboundRefusedError when the request may not be sent, did not
 * complete, or answered 5xx; any other answer is the caller's to read.
 */
export type OutboundHttp = (
  request: OutboundRequest,
) => Promise<OutboundResponse>;

export class OutboundRefusedError extends Error {
  constructor(
    readonly reason: "address_not_allowed" | "unreachable" | "answered",
    message: string,
    /** `status`: what an `answered` server answered; `timedOut`: an `unreachable` request ran out of time. */
    readonly detail: { status?: number; timedOut?: boolean } = {},
  ) {
    super(message);
  }
}
