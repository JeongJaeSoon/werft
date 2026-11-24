import { readFile } from "node:fs/promises";
import {
  CONVERSATION_NEXT_TURN_MAX_WAIT_MS,
  CONVERSATION_TURN_LEASE_MS,
  conversationRuntimeIdSchema,
} from "@werft-ai/contracts";
import { imageRuntime } from "../composition.ts";
import { createConsoleLogger } from "../console-logger.ts";
import { denySameUserInspection } from "../process-hardening.ts";
import {
  type ConversationRuntimeEnvironment,
  conversationRuntimeConfigFromEnv,
  DEFAULT_CONVERSATION_STATUS_FILE,
} from "./config.ts";
import { ConversationHost } from "./conversation-host.ts";
import { TopicDirectories } from "./topic-directories.ts";
import { createConversationTurnRunner } from "./turn-runner.ts";
import { HttpConversationTurnSource } from "./turn-source.ts";

const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;
// No poll is made while a turn runs, which its lease bounds, and the poll
// after it is held for up to the wait and its request timeout. Staler than
// all of that is a loop that no longer reaches the control host.
export const HEALTH_STALE_MS =
  CONVERSATION_TURN_LEASE_MS + CONVERSATION_NEXT_TURN_MAX_WAIT_MS + 30_000;

/**
 * The conversation runtime: the worker image started on this entry point
 * instead of the session worker's. One process serves the conversation turns
 * of every agent and topic of the installation; it claims no session, mounts
 * no workspace volume and checks out no repository.
 */
export async function main(
  environment: NodeJS.ProcessEnv & ConversationRuntimeEnvironment = process.env,
): Promise<void> {
  const config = conversationRuntimeConfigFromEnv(environment);
  const logger = createConsoleLogger({ level: environment.LOG_LEVEL });
  const topics = new TopicDirectories(config.topicsDir);
  const host = new ConversationHost({
    source: new HttpConversationTurnSource({
      baseUrl: config.gatewayUrl,
      token: config.gatewayToken,
      runtimeId: conversationRuntimeIdSchema.parse(crypto.randomUUID()),
      waitMs: CONVERSATION_NEXT_TURN_MAX_WAIT_MS,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    runner: createConversationTurnRunner({
      runtime: imageRuntime(),
      egressCredentialUrl: config.egressCredentialUrl,
      topics,
    }),
    topics,
    logger,
    statusFile: config.statusFile,
  });
  const handlers = STOP_SIGNALS.map((signal) => {
    const handler = () => host.stop(`received ${signal}`);
    process.on(signal, handler);
    return { signal, handler } as const;
  });
  try {
    await host.run();
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
}

/** Whether the loop reached the control host lately, by the file it writes. */
export async function healthy(
  environment: NodeJS.ProcessEnv & ConversationRuntimeEnvironment = process.env,
  now = Date.now(),
): Promise<boolean> {
  const file =
    environment.CONVERSATION_STATUS_FILE || DEFAULT_CONVERSATION_STATUS_FILE;
  try {
    const { polled_at } = JSON.parse(await readFile(file, "utf8")) as {
      polled_at?: unknown;
    };
    return (
      typeof polled_at === "string" &&
      now - Date.parse(polled_at) <= HEALTH_STALE_MS
    );
  } catch {
    return false;
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--health") {
    process.exit((await healthy()) ? 0 : 1);
  }
  // First: before the launch environment is read and long before the engine,
  // which shares this uid, is started.
  denySameUserInspection();
  await main();
  process.exit(0);
}
