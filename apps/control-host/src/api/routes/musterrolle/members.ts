import {
  listMembersQuerySchema,
  listMembersResponseSchema,
  listTakeoversResponseSchema,
  memberUserParamsSchema,
  sessionIdParamsSchema,
  setAccessRequestSchema,
  setAccessResponseSchema,
  takeOverSessionRequestSchema,
  takeOverSessionResponseSchema,
  updateMemberRequestSchema,
  updateMemberResponseSchema,
} from "@werft-ai/contracts";
import type { InviteService, MemberService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams, requireQuery } from "../errors.ts";

export function registerMemberRoutes(
  router: ApiRouter,
  service: Pick<
    MemberService,
    | "listTakeovers"
    | "takeOverSession"
    | "disableMember"
    | "enableMember"
    | "disableUser"
    | "enableUser"
  >,
  roles: Pick<InviteService, "listMembers" | "changeMemberRole">,
) {
  apiRoute(router, "listMembers", async (context) => {
    const query = requireQuery(context, listMembersQuerySchema);
    const page = await mapped(() =>
      roles.listMembers(context.get("caller"), query),
    );
    return jsonWithSchema(context, listMembersResponseSchema, page);
  });

  apiRoute(router, "updateMember", async (context) => {
    const params = requireParams(context, memberUserParamsSchema);
    const body = await parseJsonBody(context, updateMemberRequestSchema);
    const member = await mapped(() =>
      roles.changeMemberRole(context.get("caller"), params.user_id, body.role),
    );
    return jsonWithSchema(context, updateMemberResponseSchema, member);
  });

  for (const operation of [
    "disableMember",
    "enableMember",
    "disableUser",
    "enableUser",
  ] as const) {
    apiRoute(router, operation, async (context) => {
      const params = requireParams(context, memberUserParamsSchema);
      const body = await parseJsonBody(context, setAccessRequestSchema);
      const change = await mapped(() =>
        service[operation](
          context.get("caller"),
          params.user_id,
          body.reason ?? null,
        ),
      );
      return jsonWithSchema(context, setAccessResponseSchema, {
        member: change.member,
        receipt_id: change.receiptId,
      });
    });
  }

  apiRoute(router, "listTakeovers", async (context) => {
    const page = await mapped(() =>
      service.listTakeovers(context.get("caller")),
    );
    return jsonWithSchema(context, listTakeoversResponseSchema, page);
  });

  apiRoute(router, "takeOverSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    // The body is optional: a takeover inside the caller's share needs none.
    const body =
      (await context.req.arrayBuffer()).byteLength === 0
        ? {}
        : await parseJsonBody(context, takeOverSessionRequestSchema);
    const receipt = await mapped(() =>
      service.takeOverSession(
        context.get("caller"),
        params.id,
        body.justification ?? null,
      ),
    );
    return jsonWithSchema(context, takeOverSessionResponseSchema, receipt);
  });
}
