import { apiErrorResponseSchema } from "@werft-ai/contracts";

/** The `error` member of an API error response, parsed against the contract. */
export async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}
