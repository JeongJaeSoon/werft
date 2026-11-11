// The entrance other platform domains import (A2 in package-structure.md):
// only the names action/, decision/ and github/ use, not a barrel over the directory.
export {
  additionalContextOf,
  additionalRepositoriesOf,
  additionalRepositoryAllowed,
} from "./additional-repositories.ts";
export {
  GITHUB_API_BASE,
  repositoryBinding,
  repositoryInCeiling,
  repositoryUpstreamOf,
  type SessionCatalog,
  usesWorkspaceCeiling,
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
  viewerOf,
} from "./session-service.ts";
