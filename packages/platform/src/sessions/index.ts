// The entrance other platform domains import (A2 in tests/architecture.test.ts):
// only the names other domains use, not a barrel over the directory.
export {
  additionalContextOf,
  additionalRepositoriesOf,
  additionalRepositoryAllowed,
} from "./additional-repositories.ts";
export {
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
