import type { RolloutInspection } from "../ports/profile-rollout-store.ts";
import { sameExecutionForm } from "./profile-execution-form.ts";

export function judgeProfileRollout(
  seen: RolloutInspection,
):
  | { status: "superseded" | "applied" }
  | { status: "release"; profileId: string } {
  const { latest } = seen;
  if (
    seen.tracking !== "follow" ||
    !seen.sameLineage ||
    latest === null ||
    seen.active === null
  ) {
    return { status: "superseded" };
  }
  if (
    seen.active.version >= latest.version ||
    sameExecutionForm(seen.active, latest)
  ) {
    return { status: "applied" };
  }
  return { status: "release", profileId: latest.id };
}
