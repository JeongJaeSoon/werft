// The entrance other platform domains import (A2 in package-structure.md):
// only the names action/, decision/, github/ and scheduler/ use, not a barrel over the directory.
export {
  additionalContextOf,
  additionalRepositoriesOf,
  additionalRepositoryAllowed,
} from "./additional-repositories.ts";
export {
  type CatalogConnectionView,
  connectionOf,
  GITHUB_API_BASE,
  type RuntimeVersions,
  repositoryBinding,
  repositoryInCeiling,
  repositoryUpstreamOf,
  runtimeKindOfProvider,
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
  viewerOf,
} from "./session-service.ts";
export type { ToolCatalogs } from "./tool-names.ts";
