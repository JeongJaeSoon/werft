import type { PushRequestFlow } from "@werft-ai/contracts";

/**
 * Where a Slack push approval's follow-up turn goes: `now` asks the caller to
 * queue it, `held` keeps it for the end of the turn running now (queued then
 * only if no pull request is recorded), `pull_request` drops it because the
 * push's branch already has one.
 */
export interface PushFollowUpStore {
  hold(input: {
    sessionId: string;
    pushRequestId: string;
    message: string;
  }): Promise<"now" | "held" | "pull_request">;
  /**
   * The flow the push request was made under, as stored. The follow-up turn
   * belongs to `legacy` requests only: an `actions` request is finished by
   * the platform, whatever the install setting says now. Null when the
   * request is gone.
   */
  flowOf(input: {
    sessionId: string;
    pushRequestId: string;
  }): Promise<PushRequestFlow | null>;
}
