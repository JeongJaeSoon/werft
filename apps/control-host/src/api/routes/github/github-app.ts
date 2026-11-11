import {
  completeGitHubAppManifestRequestSchema,
  completeGitHubAppManifestResponseSchema,
  completeGitHubInstallationRequestSchema,
  completeGitHubInstallationResponseSchema,
  deleteGitHubAppResponseSchema,
  getGitHubAppResponseSchema,
  githubAppRoleParamsSchema,
  githubConnectionParamsSchema,
  listGitHubAppsResponseSchema,
  postGitHubAppRequestSchema,
  putGitHubAppRequestSchema,
  putGitHubAppResponseSchema,
  startGitHubAppManifestRequestSchema,
  startGitHubAppManifestResponseSchema,
  startGitHubInstallationResponseSchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { GitHubAppRef, GitHubAppService } from "@werft-ai/platform";
import type { Context } from "hono";
import {
  type ApiEnvironment,
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

function target(context: Context<ApiEnvironment>): {
  workspaceId: string;
  ref: GitHubAppRef;
} {
  if (context.req.param("role") === undefined) {
    const { id } = requireParams(context, workspaceParamsSchema);
    return { workspaceId: id.toLowerCase(), ref: "author" };
  }
  const { id, role } = requireParams(context, githubAppRoleParamsSchema);
  return { workspaceId: id.toLowerCase(), ref: role.toLowerCase() };
}

export function registerGitHubAppRoutes(
  router: ApiRouter,
  service: GitHubAppService,
  logger?: StructuredLogger,
) {
  for (const [get, put, remove] of [
    ["getGitHubApp", "putGitHubApp", "deleteGitHubApp"],
    [
      "getWorkspaceGitHubApp",
      "putWorkspaceGitHubApp",
      "deleteWorkspaceGitHubApp",
    ],
  ] as const) {
    apiRoute(router, get, async (context) => {
      const { workspaceId, ref } = target(context);
      const app = await mapped(() =>
        service.describe(context.get("caller"), workspaceId, ref),
      );
      return jsonWithSchema(context, getGitHubAppResponseSchema, app);
    });

    apiRoute(router, put, async (context) => {
      const { workspaceId, ref } = target(context);
      const set = await mapped(() =>
        service.register(context.get("caller"), workspaceId, ref, () =>
          parseJsonBody(context, putGitHubAppRequestSchema),
        ),
      );
      return jsonWithSchema(context, putGitHubAppResponseSchema, set);
    });

    apiRoute(router, remove, async (context) => {
      const { workspaceId, ref } = target(context);
      const deleted = await mapped(() =>
        service.remove(context.get("caller"), workspaceId, ref),
      );
      return jsonWithSchema(context, deleteGitHubAppResponseSchema, deleted);
    });
  }

  apiRoute(router, "listWorkspaceGitHubApps", async (context) => {
    const { id } = requireParams(context, workspaceParamsSchema);
    const listed = await mapped(() =>
      service.list(context.get("caller"), id.toLowerCase()),
    );
    return jsonWithSchema(context, listGitHubAppsResponseSchema, listed);
  });

  apiRoute(router, "addWorkspaceGitHubApp", async (context) => {
    const { id } = requireParams(context, workspaceParamsSchema);
    const added = await mapped(() =>
      service.add(context.get("caller"), id.toLowerCase(), () =>
        parseJsonBody(context, postGitHubAppRequestSchema),
      ),
    );
    return jsonWithSchema(context, putGitHubAppResponseSchema, added);
  });

  apiRoute(router, "startGitHubInstallation", async (context) => {
    const { id, connectionId } = requireParams(
      context,
      githubConnectionParamsSchema,
    );
    const started = await mapped(() =>
      service.startInstallation(
        context.get("caller"),
        id.toLowerCase(),
        connectionId.toLowerCase(),
      ),
    );
    return jsonWithSchema(
      context,
      startGitHubInstallationResponseSchema,
      started,
    );
  });

  apiRoute(
    router,
    "completeGitHubInstallation",
    // The setup page's URL held the state; nothing this answers may pass it on.
    async (context, next) => {
      await next();
      context.res.headers.set("Referrer-Policy", "no-referrer");
    },
    async (context) => {
      const { id } = requireParams(context, workspaceParamsSchema);
      const completed = await mapped(() =>
        service.completeInstallation(
          context.get("caller"),
          id.toLowerCase(),
          () => parseJsonBody(context, completeGitHubInstallationRequestSchema),
        ),
      );
      logger?.info("GitHub installation completed from the console", {
        connection_id: completed.connection_id,
        installation_id: completed.installation_id,
        recorded: completed.recorded,
      });
      return jsonWithSchema(
        context,
        completeGitHubInstallationResponseSchema,
        completed,
      );
    },
  );

  apiRoute(router, "startGitHubAppManifest", async (context) => {
    const { id } = requireParams(context, workspaceParamsSchema);
    const started = await mapped(() =>
      service.startManifest(context.get("caller"), id.toLowerCase(), () =>
        parseJsonBody(context, startGitHubAppManifestRequestSchema),
      ),
    );
    return jsonWithSchema(
      context,
      startGitHubAppManifestResponseSchema,
      started,
    );
  });

  apiRoute(
    router,
    "completeGitHubAppManifest",
    // The callback page's URL held the code; nothing this answers may pass
    // it on, errors included.
    async (context, next) => {
      await next();
      context.res.headers.set("Referrer-Policy", "no-referrer");
    },
    async (context) => {
      const { id } = requireParams(context, workspaceParamsSchema);
      // The code, the state and the App's secrets are never logged.
      const completed = await mapped(() =>
        service.completeManifest(context.get("caller"), id.toLowerCase(), () =>
          parseJsonBody(context, completeGitHubAppManifestRequestSchema),
        ),
      ).catch((error: unknown) => {
        if (error instanceof ApiHttpError) {
          const details = (error.details ?? {}) as Record<string, unknown>;
          logger?.warn("GitHub App manifest failed", {
            status: error.status,
            code: error.code,
            ...(typeof details.reason_code === "string"
              ? { reason_code: details.reason_code }
              : {}),
            ...(typeof details.app_id === "number"
              ? { app_id: details.app_id }
              : {}),
          });
        }
        throw error;
      });
      logger?.info("GitHub App made from a manifest", {
        app_id: completed.github_app.app_id,
        slug: completed.github_app.slug,
      });
      return jsonWithSchema(
        context,
        completeGitHubAppManifestResponseSchema,
        completed,
      );
    },
  );
}
