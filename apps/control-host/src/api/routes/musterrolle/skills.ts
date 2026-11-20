import {
  agentIdParamsSchema,
  agentSkillListSchema,
  agentSkillParamsSchema,
  putSkillAttachmentRequestSchema,
  registerSkillRequestSchema,
  registerSkillResponseSchema,
  reviewSkillVersionRequestSchema,
  SKILL_UPLOAD_BODY_MAX_BYTES,
  skillAttachmentResponseSchema,
  skillListSchema,
  skillNameParamsSchema,
  skillVersionChangeResponseSchema,
  skillVersionFilesSchema,
  skillVersionParamsSchema,
} from "@werft-ai/contracts";
import type { SkillService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerSkillRoutes(router: ApiRouter, service: SkillService) {
  apiRoute(router, "listSkills", async (context) => {
    const listed = await mapped(() => service.list(context.get("caller")));
    return jsonWithSchema(context, skillListSchema, listed);
  });

  apiRoute(router, "registerSkill", async (context) => {
    const body = await parseJsonBody(
      context,
      registerSkillRequestSchema,
      SKILL_UPLOAD_BODY_MAX_BYTES,
    );
    const registered = await mapped(() =>
      service.register(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      registerSkillResponseSchema,
      registered,
      registered.outcome === "registered" ? 201 : 200,
    );
  });

  apiRoute(router, "getSkillVersionFiles", async (context) => {
    const params = requireParams(context, skillVersionParamsSchema);
    const files = await mapped(() =>
      service.files(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, skillVersionFilesSchema, files);
  });

  apiRoute(router, "reviewSkillVersion", async (context) => {
    const params = requireParams(context, skillVersionParamsSchema);
    const body = await parseJsonBody(context, reviewSkillVersionRequestSchema);
    const reviewed = await mapped(() =>
      service.review(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, skillVersionChangeResponseSchema, reviewed);
  });

  apiRoute(router, "archiveSkillVersion", async (context) => {
    const params = requireParams(context, skillVersionParamsSchema);
    const archived = await mapped(() =>
      service.archive(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, skillVersionChangeResponseSchema, archived);
  });

  apiRoute(router, "putWorkspaceSkillAttachment", async (context) => {
    const params = requireParams(context, skillNameParamsSchema);
    const body = await parseJsonBody(context, putSkillAttachmentRequestSchema);
    const attached = await mapped(() =>
      service.putWorkspaceAttachment(context.get("caller"), params.name, body),
    );
    return jsonWithSchema(context, skillAttachmentResponseSchema, attached);
  });

  apiRoute(router, "deleteWorkspaceSkillAttachment", async (context) => {
    const params = requireParams(context, skillNameParamsSchema);
    const detached = await mapped(() =>
      service.deleteWorkspaceAttachment(context.get("caller"), params.name),
    );
    return jsonWithSchema(context, skillAttachmentResponseSchema, detached);
  });

  apiRoute(router, "listAgentSkills", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const listed = await mapped(() =>
      service.listAgent(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, agentSkillListSchema, listed);
  });

  apiRoute(router, "putAgentSkillAttachment", async (context) => {
    const params = requireParams(context, agentSkillParamsSchema);
    const body = await parseJsonBody(context, putSkillAttachmentRequestSchema);
    const attached = await mapped(() =>
      service.putAgentAttachment(
        context.get("caller"),
        params.id,
        params.name,
        body,
      ),
    );
    return jsonWithSchema(context, skillAttachmentResponseSchema, attached);
  });

  apiRoute(router, "deleteAgentSkillAttachment", async (context) => {
    const params = requireParams(context, agentSkillParamsSchema);
    const detached = await mapped(() =>
      service.deleteAgentAttachment(
        context.get("caller"),
        params.id,
        params.name,
      ),
    );
    return jsonWithSchema(context, skillAttachmentResponseSchema, detached);
  });
}
