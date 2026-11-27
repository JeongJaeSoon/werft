import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { StructuredLogger } from "@werft-ai/observability";
import { hashToken } from "@werft-ai/platform";
import { z } from "zod";

/**
 * Where the egress proxy reports a destination its forward port refused,
 * with the `egress_report` token it read off the refused request. On the
 * authorizer's listener, behind the same bearer: only the proxy says what it
 * refused, and nobody's API key reaches this port.
 */
export const EGRESS_DENIALS_PATH = "/egress-denials";

const MAX_BODY_BYTES = 4096;

const DNS_NAME =
  /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

const reportSchema = z
  .object({
    token: z.string().min(1).max(512),
    // A name or an address literal, as the proxy normalized it: no path,
    // query or userinfo can ride in it.
    host: z.string().refine((host) => isIP(host) !== 0 || DNS_NAME.test(host)),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();

/** The authorizer's listener, with the denial path taken off the front. */
export function routeEgressDenials(
  denials: (request: Request) => Promise<Response>,
  rest: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) =>
    new URL(request.url).pathname === EGRESS_DENIALS_PATH
      ? denials(request)
      : rest(request);
}

export type EgressDenialRecorder = (report: {
  tokenHash: Uint8Array;
  host: string;
  port: number;
}) => Promise<{ outcome: string }>;

function problem(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function createEgressDenialHandler(deps: {
  record: EgressDenialRecorder;
  logger: StructuredLogger;
  token: string;
}): (request: Request) => Promise<Response> {
  const expected = hashToken(`Bearer ${deps.token}`);
  return async (request) => {
    if (request.method !== "POST") {
      return problem(405, "METHOD_NOT_ALLOWED", "POST only");
    }
    // Compared as digests, as the authorizer does.
    if (
      !timingSafeEqual(
        hashToken(request.headers.get("authorization") ?? ""),
        expected,
      )
    ) {
      return problem(401, "UNAUTHORIZED", "Egress authorizer token required");
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return problem(400, "VALIDATION_ERROR", "Body is not JSON");
    }
    const parsed = reportSchema.safeParse(body);
    if (!parsed.success) {
      return problem(400, "VALIDATION_ERROR", "Not an egress denial report");
    }
    const { token, host, port } = parsed.data;
    try {
      const { outcome } = await deps.record({
        tokenHash: hashToken(token),
        host,
        port,
      });
      // The host only: the report is the proxy's word about a refusal, and
      // the token is the attempt's.
      deps.logger.info("Egress denial reported", { host, port, outcome });
    } catch (error) {
      deps.logger.warn("Egress denial not recorded", {
        error: error instanceof Error ? error.message : String(error),
      });
      return problem(503, "STORAGE_UNAVAILABLE", "Denial not recorded");
    }
    // Whatever became of it: the proxy has nothing to do with the answer.
    return new Response(null, { status: 204 });
  };
}
