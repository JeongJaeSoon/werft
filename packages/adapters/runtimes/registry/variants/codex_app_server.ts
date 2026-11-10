import { codexRuntimeModule } from "@werft-ai/runtime-codex";
import type { RuntimeModule } from "@werft-ai/runtime-core";

/**
 * The registry of a Codex worker image. `apps/worker/Dockerfile` copies this
 * over `src/index.ts` (and `codex_app_server.package.json` over `package.json`)
 * when `WORKER_RUNTIME=codex_app_server`, so the image holds this engine and
 * no other: the import, the installed dependencies and `image:verify` all
 * follow the one choice. `src/index.ts` is the Claude image's.
 */
export const installedRuntimes: readonly RuntimeModule[] = [codexRuntimeModule];
