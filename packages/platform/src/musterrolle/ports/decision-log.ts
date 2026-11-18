import type {
  AuthorizationDecision,
  AuthorizationRequest,
} from "@werft-ai/contracts";

export interface DecisionLog {
  record(entry: {
    request: AuthorizationRequest;
    decision: AuthorizationDecision;
  }): Promise<void>;
}

export interface AuditRetentionStore {
  /**
   * False when the workspace does not exist or `ownerUserId` is no longer an
   * active owner of it when the write commits.
   */
  setAuditRetentionDays(input: {
    workspaceId: string;
    ownerUserId: string;
    days: number;
  }): Promise<boolean>;
}
