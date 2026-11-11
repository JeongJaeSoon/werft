import {
  type WorkspaceLimitMode,
  workspaceLimitModeSchema,
} from "@werft-ai/contracts";
import type {
  ArchiveChunkRow,
  ArchivedEventCache,
} from "../sessions/session-event-archives.ts";

export async function readArchivedWorkspaceLimit(
  archive: Pick<ArchivedEventCache, "lines"> | undefined,
  chunks: readonly (ArchiveChunkRow & { lastCreatedAt: Date })[],
  attempt: { id: string; startedAt: Date },
): Promise<WorkspaceLimitMode | undefined> {
  if (archive === undefined) return;
  try {
    for (const chunk of chunks) {
      if (chunk.lastCreatedAt < attempt.startedAt) continue;
      const lines = await archive.lines(chunk);
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index]?.line;
        if (line === undefined) continue;
        const event = JSON.parse(line) as {
          type?: string;
          attempt_id?: string;
          payload?: { subtype?: string } | null;
        } | null;
        if (
          event?.attempt_id !== attempt.id ||
          event.type !== "system" ||
          event.payload?.subtype !== "workspace_limit_mode"
        )
          continue;
        const parsed = workspaceLimitModeSchema.safeParse(event.payload);
        return parsed.success ? parsed.data : undefined;
      }
    }
  } catch {
    // Optional diagnostics must not prevent reading the session itself.
    return;
  }
}
