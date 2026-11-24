import { createPostgresConversationCalls } from "@werft-ai/db";
import {
  type ConversationCallExecutor,
  createConversationCallExecutor,
  createConversationCalls,
  type SessionCatalog,
} from "@werft-ai/platform";
import { oneHostOutbound } from "../api/outbound-http.ts";

/**
 * The conversation call executor over PostgreSQL, sending through the egress
 * proxy's credential listener at `egressUrl` and nowhere else.
 */
export function wireConversationCallExecutor(deps: {
  db: Parameters<typeof createPostgresConversationCalls>[0];
  catalog: Pick<SessionCatalog, "connections">;
  egressUrl: string;
  logger: Parameters<typeof createConversationCallExecutor>[0]["logger"];
}): ConversationCallExecutor {
  return createConversationCallExecutor({
    calls: createConversationCalls({
      store: createPostgresConversationCalls(deps.db),
      catalog: deps.catalog,
    }),
    egressUrl: deps.egressUrl,
    http: oneHostOutbound(deps.egressUrl, { private: true }),
    logger: deps.logger,
  });
}
