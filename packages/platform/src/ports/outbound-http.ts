/** One request control-host sends a server itself, under the outbound policy. */
export type OutboundRequest = {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};
export type OutboundResponse = {
  status: number;
  headers: Headers;
  text: string;
};
/**
 * Throws WorkspaceMcpOutboundError when the request may not be sent, did
 * not complete, or answered 5xx; any other answer is the caller's to read.
 */
export type OutboundHttp = (
  request: OutboundRequest,
) => Promise<OutboundResponse>;

export class WorkspaceMcpOutboundError extends Error {
  constructor(
    readonly reason: "address_not_allowed" | "unreachable" | "answered",
    message: string,
  ) {
    super(message);
  }
}
