import {
  checkSkillRepositoryResponseSchema,
  putSkillRepositoryRefRequestSchema,
  putSkillRepositoryRefResponseSchema,
  registerSkillRepositoryRequestSchema,
  registerSkillRepositoryResponseSchema,
  removeSkillRepositoryResponseSchema,
  skillRepositoryDetailSchema,
  skillRepositoryListSchema,
  skillRepositoryParamsSchema,
} from "@werft-ai/contracts";
import type { SkillRepositoryService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerSkillRepositoryRoutes(
  router: ApiRouter,
  service: SkillRepositoryService,
) {
  apiRoute(router, "listSkillRepositories", async (context) => {
    const listed = await mapped(() => service.list(context.get("caller")));
    return jsonWithSchema(context, skillRepositoryListSchema, listed);
  });

  apiRoute(router, "registerSkillRepository", async (context) => {
    const body = await parseJsonBody(
      context,
      registerSkillRepositoryRequestSchema,
    );
    const registered = await mapped(() =>
      service.register(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      registerSkillRepositoryResponseSchema,
      registered,
      201,
    );
  });

  apiRoute(router, "getSkillRepository", async (context) => {
    const params = requireParams(context, skillRepositoryParamsSchema);
    const found = await mapped(() =>
      service.get(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, skillRepositoryDetailSchema, found);
  });

  apiRoute(router, "removeSkillRepository", async (context) => {
    const params = requireParams(context, skillRepositoryParamsSchema);
    const removed = await mapped(() =>
      service.remove(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      removeSkillRepositoryResponseSchema,
      removed,
    );
  });

  apiRoute(router, "checkSkillRepository", async (context) => {
    const params = requireParams(context, skillRepositoryParamsSchema);
    const checked = await mapped(() =>
      service.checkNow(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, checkSkillRepositoryResponseSchema, checked);
  });

  apiRoute(router, "putSkillRepositoryRef", async (context) => {
    const params = requireParams(context, skillRepositoryParamsSchema);
    const body = await parseJsonBody(
      context,
      putSkillRepositoryRefRequestSchema,
    );
    const changed = await mapped(() =>
      service.setRef(context.get("caller"), params.id, body.ref),
    );
    return jsonWithSchema(
      context,
      putSkillRepositoryRefResponseSchema,
      changed,
    );
  });
}
