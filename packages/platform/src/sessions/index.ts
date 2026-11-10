// The entrance other platform domains import (A2 in package-structure.md):
// only the names action/ and decision/ use, not a barrel over the directory.
export { additionalRepositoryAllowed } from "./additional-repositories.ts";
export {
  repositoryBinding,
  repositoryUpstreamOf,
  type SessionCatalog,
} from "./catalog.ts";
export {
  closeOpenBlocks,
  pullRequestTail,
  pushRequestMarkerOf,
  sessionUrlOf,
  surfaceOfChannel,
  type TailRequester,
  withPullRequestTail,
} from "./git-attribution.ts";
export type { RepositoryAttachmentService } from "./repository-attachment-service.ts";
export {
  idempotencyConflict,
  payloadHash,
  requireAllowed,
  requirePermitted,
  SessionServiceError,
  selfApproval,
} from "./session-service.ts";
