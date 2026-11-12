import type { ApiError } from "@werft-ai/client";
import { permissionReason } from "../auth/guard.tsx";
import { errorKey, type Translate } from "../i18n/i18n.tsx";

// The release check's model refusal (release-ids.ts), as "<field>: <message>".
const MODEL_REFUSAL =
  /^card\.model: model (.+) is not a model of connection (.+)$/;

/**
 * What a refused agent action says: a 403 in the words of the disabled
 * button, a model mismatch in our words, any other capability the connection
 * does not have with the server's reason.
 */
export function agentRefusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
): string {
  if (error.code === "FORBIDDEN")
    return permissionReason(t, "agent.manage", role);
  // Only making an agent answers this: its slug is taken.
  if (error.code === "ALREADY_EXISTS") return t("agents.slugTaken");
  const model =
    error.code === "UNSUPPORTED_CAPABILITY"
      ? MODEL_REFUSAL.exec(error.message)
      : null;
  if (model)
    return t("agent.releases.modelRefused", {
      card: model[1] ?? "",
      connection: model[2] ?? "",
    });
  if (error.code === "UNSUPPORTED_CAPABILITY" || error.code === "BAD_REQUEST")
    return `${t(errorKey(error.code))} ${error.message}`;
  return t(errorKey(error.code));
}
