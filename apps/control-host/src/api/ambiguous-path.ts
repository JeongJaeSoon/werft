import type { StructuredLogger } from "@werft-ai/observability";

// Bun has already turned a raw backslash into "/" (and folded the dot
// segments around it) by the time a handler sees request.url, so only the
// encoded form is still visible here; the proxy in front refuses the raw one.
// Only the path counts: a query may carry %5C as data.
const ENCODED_BACKSLASH = /%5c/i;
const LOGGED_PATH_CHARS = 200;

export type ListenerFetch<Rest extends unknown[]> = (
  request: Request,
  ...rest: Rest
) => Response | Promise<Response>;

export interface AmbiguousPathGuard {
  /** Requests refused since the process started, over every listener. */
  readonly total: () => number;
  /** `fetch` behind a check that answers 400 with no body before it runs. */
  front<Rest extends unknown[]>(
    listener: string,
    fetch: ListenerFetch<Rest>,
  ): ListenerFetch<Rest>;
}

/**
 * One per process: a path with an encoded backslash means one thing to a
 * proxy that matches the path as sent and another once something behind it
 * decodes it, so it is refused before any routing on every listener.
 */
export function ambiguousPathGuard(
  logger: Pick<StructuredLogger, "warn">,
): AmbiguousPathGuard {
  let total = 0;
  return {
    total: () => total,
    front(listener, fetch) {
      return (request, ...rest) => {
        const path = new URL(request.url).pathname;
        if (!ENCODED_BACKSLASH.test(path)) return fetch(request, ...rest);
        total += 1;
        logger.warn("Request refused: its path holds an encoded backslash", {
          event: "api.request.rejected_ambiguous_path",
          listener,
          path: path.slice(0, LOGGED_PATH_CHARS),
          rejected_ambiguous_path_total: total,
        });
        return new Response(null, { status: 400 });
      };
    },
  };
}
