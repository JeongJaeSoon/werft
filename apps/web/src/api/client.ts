import {
  type ApiClient,
  type ApiClientOptions,
  createApiClient as createContractClient,
} from "@werft-ai/client";
import { contractValidators, warnOncePerIssue } from "@werft-ai/core/schemas";
import { retryingFetch } from "./retry.ts";

export interface WebClientOptions extends ApiClientOptions {
  /** Waits between attempts of a GET or HEAD a gateway failed; tests shorten them. */
  readonly readRetryDelaysMs?: readonly number[];
}

/**
 * A client that holds every answer to the published contract. The mode stays
 * the caller's: off unless `validate` says otherwise.
 */
export function createApiClient(options: WebClientOptions = {}): ApiClient {
  const { readRetryDelaysMs, ...rest } = options;
  // Read at call time: a fetch replaced after the client is made still answers.
  const fetch =
    options.fetch ?? ((request: Request) => globalThis.fetch(request));
  return createContractClient({
    validators: contractValidators,
    onContractMismatch: warnOncePerIssue(),
    ...rest,
    fetch: retryingFetch(fetch, readRetryDelaysMs),
  });
}
