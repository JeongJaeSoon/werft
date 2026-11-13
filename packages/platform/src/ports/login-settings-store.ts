/** Who may sign in with a password (design 9.1). */
export type PasswordLogin = "on" | "emergency_only";

export type LoginSettingsRecord = {
  passwordLogin: PasswordLogin;
  /** Null only on an installation that has never had one (design 9.2). */
  emergencyAdmin: {
    userId: string;
    email: string;
    displayName: string;
    /** Still an owner who can sign in with a password. */
    eligible: boolean;
  } | null;
  /** How many providers are on. */
  enabledProviders: number;
};

/** The owner making a change, and the receipt it leaves. */
export type LoginSettingsAudit = {
  userId: string;
  workspaceId: string;
  receiptId: string;
};

export type SetPasswordLoginResult =
  | {
      outcome: "changed";
      settings: LoginSettingsRecord;
      sessionsRevoked: number;
    }
  | { outcome: "unchanged"; settings: LoginSettingsRecord }
  /** No provider is on: nobody but the emergency admin could come in. */
  | { outcome: "no_provider" }
  /** None is named, or the one named can no longer sign in with a password. */
  | { outcome: "no_emergency_admin" }
  /** The owner asking would not get back in: no provider account, not the emergency admin. */
  | { outcome: "locks_out_actor" };

export type SetEmergencyAdminResult =
  | { outcome: "changed" | "unchanged"; settings: LoginSettingsRecord }
  /** Not a live owner of the workspace with a password. */
  | { outcome: "not_eligible" }
  /**
   * Under `emergency_only`: the owner asking is the one being replaced and
   * has no provider account to come back with.
   */
  | { outcome: "locks_out_actor" };

/** The installation's password switch and its emergency admin. */
export interface LoginSettingsStore {
  read(): Promise<LoginSettingsRecord>;
  /**
   * `emergency_only` ends, in the same transaction, the password sessions
   * of everyone but the emergency admin.
   */
  setPasswordLogin(input: {
    value: PasswordLogin;
    audit: LoginSettingsAudit;
  }): Promise<SetPasswordLoginResult>;
  /** Names another owner; the designation is replaced, never cleared. */
  setEmergencyAdmin(input: {
    userId: string;
    audit: LoginSettingsAudit;
  }): Promise<SetEmergencyAdminResult>;
}
