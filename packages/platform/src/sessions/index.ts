// The entrance other platform domains import (A2 in tests/architecture.test.ts):
// only the names other domains use, not a barrel over the directory.
export type { JudgmentEgressStore } from "./achievements/achievement-judgment-store.ts";
export type { JudgeConnections } from "./achievements/judge-connections.ts";
export {
  hashJudgmentToken,
  JUDGMENT_TOKEN_PREFIX,
} from "./achievements/judgment-token.ts";
export {
  additionalContextOf,
  additionalRepositoriesOf,
  additionalRepositoryAllowed,
} from "./additional-repositories.ts";
export { type NeutralizeEvent, neutralFieldsOf } from "./event-codecs.ts";
export {
  appBotAuthor,
  claimGitOf,
  coAuthorOf,
  coAuthorOfLink,
  sessionUrlOf,
} from "./git-attribution.ts";
export type { RepositoryAttachmentService } from "./repository-attachment-service.ts";
export {
  idempotencyConflict,
  payloadHash,
  selfApproval,
  viewerOf,
} from "./session-service.ts";
export {
  hashTitleToken,
  type SessionTitler,
  TITLE_MAX_TOKENS,
  TITLE_PROVIDER_PATH,
  TITLE_TOKEN_PREFIX,
  titleRun,
} from "./session-titler.ts";
