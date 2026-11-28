import {
  adminTerminateSessionRequestSchema,
  auditReadRequestSchema,
  auditReadResponseSchema,
  controlAcceptedResponseSchema,
  listAdminSessionsResponseSchema,
  recoveryDecisionRequestSchema,
  sessionIdParamsSchema,
  sessionShareSchema,
  setSessionShareRequestSchema,
  setSessionShareResponseSchema,
  terminateSessionResponseSchema,
} from "@werft-ai/contracts";
import type { SessionService, SessionShareService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "../errors.ts";

export function registerSessionShareRoutes(
  router: ApiRouter,
  shares: SessionShareService,
  sessions: Pick<
    SessionService,
    "auditRead" | "terminateSession" | "decideRecovery"
  >,
) {
  apiRoute(router, "getSessionShare", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const share = await mapped(() =>
      shares.getShare(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, sessionShareSchema, share);
  });

  apiRoute(router, "setSessionShare", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const body = await parseJsonBody(context, setSessionShareRequestSchema);
    const change = await mapped(() =>
      shares.setShare(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, setSessionShareResponseSchema, change);
  });

  apiRoute(router, "auditReadSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const body = await parseJsonBody(context, auditReadRequestSchema);
    const read = await mapped(() =>
      sessions.auditRead(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, auditReadResponseSchema, read);
  });

  apiRoute(router, "listAdminSessions", async (context) => {
    const page = await mapped(() => shares.listForAdmin(context.get("caller")));
    return jsonWithSchema(context, listAdminSessionsResponseSchema, page);
  });

  apiRoute(router, "adminTerminateSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(
      context,
      adminTerminateSessionRequestSchema,
    );
    const accepted = await mapped(() =>
      sessions.terminateSession(context.get("caller"), params.id, {
        idempotencyKey: key,
        body: { expected_revision: body.expected_revision },
        justification: body.justification,
      }),
    );
    return jsonWithSchema(
      context,
      terminateSessionResponseSchema,
      accepted,
      202,
    );
  });
  // The decision's reason doubles as the justification the policy asks for.
  apiRoute(router, "adminDecideSessionRecovery", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, recoveryDecisionRequestSchema);
    const accepted = await mapped(() =>
      sessions.decideRecovery(context.get("caller"), params.id, {
        idempotencyKey: key,
        body,
        justification: body.reason,
      }),
    );
    return jsonWithSchema(
      context,
      controlAcceptedResponseSchema,
      accepted,
      202,
    );
  });
}
