import {
  githubSettingsResponseSchema,
  putGitHubOAuthClientSecretRequestSchema,
  putGitHubOAuthClientSecretResponseSchema,
  putGitHubPullRequestSettingsRequestSchema,
  putGitHubPullRequestSettingsResponseSchema,
  putGitHubSettingsRequestSchema,
  putGitHubUserLinkAppRequestSchema,
  putGitHubUserLinkAppResponseSchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type { GitHubSettingsService } from "@werft-ai/platform";
import type { Context } from "hono";
import {
  type ApiEnvironment,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

function lowercaseWorkspaceId(context: Context<ApiEnvironment>): string {
  return requireParams(context, workspaceParamsSchema).id.toLowerCase();
}

export function registerGitHubSettingsRoutes(
  router: ApiRouter,
  service: GitHubSettingsService,
) {
  apiRoute(router, "getGitHubSettings", async (context) => {
    const settings = await mapped(() =>
      service.get(context.get("caller"), lowercaseWorkspaceId(context)),
    );
    return jsonWithSchema(context, githubSettingsResponseSchema, settings);
  });

  apiRoute(router, "putGitHubSettings", async (context) => {
    const settings = await mapped(() =>
      service.put(context.get("caller"), lowercaseWorkspaceId(context), () =>
        parseJsonBody(context, putGitHubSettingsRequestSchema),
      ),
    );
    return jsonWithSchema(context, githubSettingsResponseSchema, settings);
  });

  apiRoute(router, "putGitHubPullRequestSettings", async (context) => {
    const stored = await mapped(() =>
      service.putPullRequest(
        context.get("caller"),
        lowercaseWorkspaceId(context),
        () => parseJsonBody(context, putGitHubPullRequestSettingsRequestSchema),
      ),
    );
    return jsonWithSchema(
      context,
      putGitHubPullRequestSettingsResponseSchema,
      stored,
    );
  });

  apiRoute(router, "putGitHubOAuthClientSecret", async (context) => {
    const stored = await mapped(() =>
      service.putOAuthClientSecret(
        context.get("caller"),
        lowercaseWorkspaceId(context),
        () => parseJsonBody(context, putGitHubOAuthClientSecretRequestSchema),
      ),
    );
    return jsonWithSchema(
      context,
      putGitHubOAuthClientSecretResponseSchema,
      stored,
    );
  });

  apiRoute(router, "putGitHubUserLinkApp", async (context) => {
    const stored = await mapped(() =>
      service.putUserLinkApp(
        context.get("caller"),
        lowercaseWorkspaceId(context),
        () => parseJsonBody(context, putGitHubUserLinkAppRequestSchema),
      ),
    );
    return jsonWithSchema(context, putGitHubUserLinkAppResponseSchema, stored);
  });
}
