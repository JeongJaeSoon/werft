import { randomBytes } from "node:crypto";
import { hashToken } from "../../token-hash.ts";
import type {
  ClaimedJudgment,
  JudgmentEgressStore,
} from "./achievement-judgment-store.ts";

export const JUDGMENT_TOKEN_PREFIX = "wej_";

export const hashJudgmentToken = hashToken;

/**
 * The claimed judgment's egress token, good for the judgment route only and
 * only while the judge holds the judgment's lease; null once it does not.
 */
export async function issueJudgmentToken(
  store: Pick<JudgmentEgressStore, "issueToken">,
  judgment: ClaimedJudgment,
): Promise<string | null> {
  const token = `${JUDGMENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return (await store.issueToken(judgment, hashJudgmentToken(token)))
    ? token
    : null;
}
