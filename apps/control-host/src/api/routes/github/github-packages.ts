import {
  githubPackagesSettingsResponseSchema,
  githubPackagesWriteResponseSchema,
  putGitHubPackagesAllowlistRequestSchema,
  putGitHubPackagesTokenRequestSchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type { createGitHubPackagesService } from "@werft-ai/platform";
import type { Context } from "hono";
import {
  type ApiEnvironment,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

type GitHubPackagesService = ReturnType<typeof createGitHubPackagesService>;

function workspaceIdOf(context: Context<ApiEnvironment>): string {
  return requireParams(context, workspaceParamsSchema).id.toLowerCase();
}

export function registerGitHubPackagesRoutes(
  router: ApiRouter,
  service: GitHubPackagesService,
) {
  apiRoute(router, "getGitHubPackages", async (context) => {
    const settings = await mapped(() =>
      service.get(context.get("caller"), workspaceIdOf(context)),
    );
    return jsonWithSchema(
      context,
      githubPackagesSettingsResponseSchema,
      settings,
    );
  });

  apiRoute(router, "putGitHubPackagesToken", async (context) => {
    const stored = await mapped(() =>
      service.putToken(context.get("caller"), workspaceIdOf(context), () =>
        parseJsonBody(context, putGitHubPackagesTokenRequestSchema),
      ),
    );
    return jsonWithSchema(context, githubPackagesWriteResponseSchema, stored);
  });

  apiRoute(router, "deleteGitHubPackagesToken", async (context) => {
    const deleted = await mapped(() =>
      service.deleteToken(context.get("caller"), workspaceIdOf(context)),
    );
    return jsonWithSchema(context, githubPackagesWriteResponseSchema, deleted);
  });

  apiRoute(router, "putGitHubPackagesAllowlist", async (context) => {
    const stored = await mapped(() =>
      service.putAllowlist(context.get("caller"), workspaceIdOf(context), () =>
        parseJsonBody(context, putGitHubPackagesAllowlistRequestSchema),
      ),
    );
    return jsonWithSchema(context, githubPackagesWriteResponseSchema, stored);
  });
}
