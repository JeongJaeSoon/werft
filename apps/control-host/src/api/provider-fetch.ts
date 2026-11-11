const PROVIDER_HTTP_TIMEOUT_MS = 10_000;

/**
 * A request to an OAuth or OIDC provider under a deadline. One that did not
 * complete and a 5xx answer both throw what `unavailable` builds; any other
 * response is the caller's to read.
 */
export async function providerFetch(
  url: string,
  init: RequestInit | undefined,
  unavailable: {
    unreachable: (error: unknown) => Error;
    answered: (status: number) => Error;
  },
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PROVIDER_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw unavailable.unreachable(error);
  }
  if (response.status >= 500) throw unavailable.answered(response.status);
  return response;
}
