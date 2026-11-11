import {
  agentIdParamsSchema,
  completeSlackInstallRequestSchema,
  completeSlackInstallResponseSchema,
  startSlackInstallResponseSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SlackInstallService } from "../../../wiring/chat-slack.ts";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

// Each value is a fixed name, a number or a code checked against
// /^[a-z_]{1,64}$/ before it got here; anything else in details stays out.
const LOGGED_DETAILS = [
  "reason_code",
  "slack_method",
  "failure",
  "http_status",
  "slack_error",
] as const;

function loggedDetails(details: unknown) {
  const fields: Record<string, string | number> = {};
  if (details === null || typeof details !== "object") return fields;
  for (const key of LOGGED_DETAILS) {
    const value = (details as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number") {
      fields[key] = value;
    }
  }
  return fields;
}

// The state, the code and the bot token are never logged: only ids and the
// outcome are.
export function registerSlackInstallRoutes(
  router: ApiRouter,
  deps: { service: SlackInstallService; logger?: StructuredLogger },
) {
  const { service, logger } = deps;

  apiRoute(router, "startSlackInstall", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const started = await mapped(() =>
      service.start(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, startSlackInstallResponseSchema, started);
  });

  apiRoute(
    router,
    "completeSlackInstall",
    // The callback page's URL held the code; nothing this answers may pass
    // it on, errors included.
    async (context, next) => {
      await next();
      context.res.headers.set("Referrer-Policy", "no-referrer");
    },
    async (context) => {
      const body = await parseJsonBody(
        context,
        completeSlackInstallRequestSchema,
      );
      const completed = await mapped(() =>
        service.complete(context.get("caller"), body),
      ).catch((error: unknown) => {
        if (error instanceof ApiHttpError) {
          logger?.warn("Slack install failed", {
            agent_id: body.agent_id,
            status: error.status,
            code: error.code,
            ...loggedDetails(error.details),
          });
        }
        throw error;
      });
      logger?.info("Slack app installed", {
        agent_id: completed.slack_app.agent_id,
        slack_app_id: completed.slack_app.id,
        app_id: completed.installation.app_id,
        team_id: completed.installation.team_id,
        installation_id: completed.installation.id,
        identity_id: completed.agent_identity.id,
        finalized: completed.finalized,
        // `reinstall_required` is kept nowhere else yet (94S-793 decides).
        warnings: completed.warnings.map((warning) => warning.code),
      });
      return jsonWithSchema(
        context,
        completeSlackInstallResponseSchema,
        completed,
      );
    },
  );
}
