import {
  agentIdParamsSchema,
  agentSkillListSchema,
  agentSkillParamsSchema,
  checkSkillResponseSchema,
  putSkillAttachmentRequestSchema,
  putSkillAutoApproveRequestSchema,
  putSkillSyncRequestSchema,
  registerGitHubSkillRequestSchema,
  registerSkillRequestSchema,
  registerSkillResponseSchema,
  revertSkillResponseSchema,
  reviewSkillVersionRequestSchema,
  SKILL_UPLOAD_BODY_MAX_BYTES,
  skillAttachmentResponseSchema,
  skillListSchema,
  skillNameParamsSchema,
  skillSyncResponseSchema,
  skillVersionChangeResponseSchema,
  skillVersionFilesSchema,
  skillVersionParamsSchema,
} from "@werft-ai/contracts";
import type { SkillGitSync, SkillService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerSkillRoutes(
  router: ApiRouter,
  service: SkillService,
  sync?: SkillGitSync,
) {
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

  if (sync !== undefined) {
    apiRoute(router, "registerGitHubSkill", async (context) => {
      const body = await parseJsonBody(
        context,
        registerGitHubSkillRequestSchema,
      );
      const registered = await mapped(() =>
        sync.register(context.get("caller"), body),
      );
      return jsonWithSchema(
        context,
        registerSkillResponseSchema,
        registered,
        201,
      );
    });

    apiRoute(router, "checkSkill", async (context) => {
      const params = requireParams(context, skillNameParamsSchema);
      const checked = await mapped(() =>
        sync.checkNow(context.get("caller"), params.name),
      );
      return jsonWithSchema(context, checkSkillResponseSchema, checked);
    });

    apiRoute(router, "putSkillSync", async (context) => {
      const params = requireParams(context, skillNameParamsSchema);
      const body = await parseJsonBody(context, putSkillSyncRequestSchema);
      const changed = await mapped(() =>
        sync.setSync(context.get("caller"), params.name, body.enabled),
      );
      return jsonWithSchema(context, skillSyncResponseSchema, changed);
    });

    apiRoute(router, "putSkillAutoApprove", async (context) => {
      const params = requireParams(context, skillNameParamsSchema);
      const body = await parseJsonBody(
        context,
        putSkillAutoApproveRequestSchema,
      );
      const changed = await mapped(() =>
        sync.setAutoApprove(context.get("caller"), params.name, body.action),
      );
      return jsonWithSchema(context, skillSyncResponseSchema, changed);
    });
  }

  apiRoute(router, "revertSkill", async (context) => {
    const params = requireParams(context, skillNameParamsSchema);
    const reverted = await mapped(() =>
      service.revert(context.get("caller"), params.name),
    );
    return jsonWithSchema(context, revertSkillResponseSchema, reverted);
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
