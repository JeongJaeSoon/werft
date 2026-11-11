import { SessionServiceError } from "../musterrolle/service-errors.ts";

/** Awaits a call that must be refused and returns the refusal's code and details. */
export async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}
