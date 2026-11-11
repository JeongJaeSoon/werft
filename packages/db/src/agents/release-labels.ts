import { sql } from "drizzle-orm";
import type { agentReleases } from "../schema.ts";

// Seoul, as every timestamp the console shows (packages/ui formatTimestamp).
const SECOND = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** `releaseLabelSchema`: the Seoul second, then `-2`, `-3`, … for a tie. */
export function releaseLabel(createdAt: Date, earlierInSecond: number): string {
  const parts = new Map(
    SECOND.formatToParts(createdAt).map((part) => [part.type, part.value]),
  );
  const at = (type: Intl.DateTimeFormatPartTypes) => parts.get(type) ?? "";
  const second = `${at("year")}-${at("month")}-${at("day")}_${at("hour")}:${at("minute")}:${at("second")}`;
  return earlierInSecond === 0 ? second : `${second}-${earlierInSecond + 1}`;
}

/**
 * The agent's releases made earlier in the same second, in (created_at, id)
 * order. Whole-hour zone offsets keep a UTC second a Seoul second.
 */
export function earlierInSecond(release: typeof agentReleases) {
  return sql<number>`(SELECT count(*)::int FROM agent_releases AS same_second
    WHERE same_second.agent_id = ${release.agentId}
      AND date_trunc('second', same_second.created_at)
        = date_trunc('second', ${release.createdAt})
      AND (same_second.created_at, same_second.id)
        < (${release.createdAt}, ${release.id}))`;
}
