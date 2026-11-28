import { githubUnavailableOf } from "../github/ports/github-app-store.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  requirePermitted,
  SessionServiceError,
} from "../musterrolle/index.ts";

// What the services that change a workspace's GitHub skills share: who may,
// and the two refusals GitHub's answers turn into.

export const refused = (reasonCode: string, message: string, details = {}) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code: reasonCode,
    ...details,
  });

export const unavailable = (error: unknown) =>
  new SessionServiceError(
    "GITHUB_UNAVAILABLE",
    "GitHub could not be read with the workspace's App",
    undefined,
    { reason_code: githubUnavailableOf(error) },
  );

/** The person changing skills: a workspace manager in a console session. */
export async function skillManager(
  authorization: AuthorizationPolicy,
  caller: Caller,
): Promise<string> {
  const userId = caller.actor?.userId;
  if (
    caller.subject.surface.kind !== "web" ||
    caller.subject.principal?.kind !== "user" ||
    !userId
  ) {
    throw new SessionServiceError(
      "FORBIDDEN",
      "Skills are changed from a signed-in console session, not with an API key",
      undefined,
      { reason_code: "web_session_required" },
    );
  }
  await requirePermitted(authorization, caller, "workspace.manage", {
    kind: "workspace",
    id: caller.ownerId,
  });
  return userId;
}
