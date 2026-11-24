import type {
  ConversationRuntimeTurns,
  WorkerGateway,
} from "@werft-ai/platform";
import type { ApiRouter } from "../../app.ts";
import type { RequestTracing } from "../../request-tracing.ts";
import { registerConversationRuntimeRoutes } from "./conversation-runtime.ts";
import { registerWorkerRoutes } from "./worker.ts";

/**
 * Everything the API mounts under /internal, on the internal listener alone
 * (createInternalApiApp). That port is not public, but every peer inside
 * reaches it, so each family still refuses a call without its own bearer;
 * the test beside this walks every route registered here to hold that.
 */
export function registerInternalApiRoutes(
  router: ApiRouter,
  deps: {
    workers: WorkerGateway;
    tracing: RequestTracing;
    conversationRuntime?: {
      turns: ConversationRuntimeTurns;
      isRuntimeBearer: (token: string | null) => boolean;
    };
    stop?: AbortSignal;
  },
) {
  if (deps.conversationRuntime !== undefined) {
    registerConversationRuntimeRoutes(router, {
      ...deps.conversationRuntime,
      ...(deps.stop === undefined ? {} : { stop: deps.stop }),
    });
  }
  registerWorkerRoutes(router, deps.workers, deps.tracing);
}
