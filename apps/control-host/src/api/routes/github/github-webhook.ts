import { githubWebhookResponseSchema } from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SkillGitSync } from "@werft-ai/platform";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  ingestThenStopClock,
  jsonWithSchema,
} from "../../app.ts";
import type { SlackEventsLimiter } from "../../rate-limit.ts";

export const GITHUB_WEBHOOK_PATH = "/v1/github/webhook";

/**
 * GITHUB_WEBHOOK_BASE_URL: the https address GitHub reaches this API at,
 * without a query, fragment or credentials. A path prefix stays, for a proxy
 * that routes on it. Unset, Apps get no webhook.
 */
export function githubWebhookUrlFrom(
  env: Record<string, string | undefined>,
): string | null {
  const value = env.GITHUB_WEBHOOK_BASE_URL;
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GITHUB_WEBHOOK_BASE_URL must be an absolute URL");
  }
  if (
    url.protocol !== "https:" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(
      "GITHUB_WEBHOOK_BASE_URL must be an https URL without a query, fragment or credentials",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}${GITHUB_WEBHOOK_PATH}`;
}

export function registerGitHubWebhookRoutes(
  router: ApiRouter,
  deps: {
    sync: SkillGitSync;
    limiter: SlackEventsLimiter;
    logger?: StructuredLogger;
  },
) {
  const { sync, limiter, logger } = deps;
  apiRoute(
    router,
    "receiveGitHubWebhook",
    async (context, next) => {
      const appId =
        context.req.header("X-GitHub-Hook-Installation-Target-ID") ?? "";
      const admitted = limiter.admit(appId);
      if (!admitted.ok) {
        throw new ApiHttpError(
          429,
          "RATE_LIMITED",
          "Too many GitHub deliveries, try again later",
          true,
          admitted.retryAfter,
        );
      }
      return ingestThenStopClock(context, next);
    },
    async (context) => {
      const appId =
        context.req.header("X-GitHub-Hook-Installation-Target-ID") ?? null;
      const deliveryId = context.req.header("X-GitHub-Delivery") ?? null;
      const outcome = await sync.receive({
        appId,
        event: context.req.header("X-GitHub-Event") ?? null,
        deliveryId,
        signature: context.req.header("X-Hub-Signature-256") ?? null,
        body: new Uint8Array(await context.req.arrayBuffer()),
      });
      if (outcome === "unauthorized") {
        logger?.warn("GitHub delivery refused", { app_id: appId });
        throw new ApiHttpError(
          401,
          "UNAUTHORIZED",
          "Request signature is not valid",
        );
      }
      logger?.info("GitHub delivery received", {
        app_id: appId,
        delivery_id: deliveryId,
      });
      return jsonWithSchema(
        context,
        githubWebhookResponseSchema,
        { accepted: true },
        202,
      );
    },
  );
}
