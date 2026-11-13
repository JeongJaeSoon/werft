import type {
  LoginSettingsView,
  UpdateLoginSettingsRequest,
  UpdateLoginSettingsResponse,
} from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  type LoginSettingsRecord,
  type LoginSettingsStore,
  SessionServiceError,
} from "@werft-ai/platform";
import { requireSignInOwner } from "./provider-admin.ts";

type Refusal =
  | "no_provider"
  | "no_emergency_admin"
  | "locks_out_actor"
  | "not_eligible";

const REFUSED: Record<Refusal, string> = {
  no_provider: "Turn a sign-in provider on before closing password sign-in",
  no_emergency_admin:
    "Name an emergency admin who can sign in with a password first",
  locks_out_actor:
    "You would not get back in: connect an account of a provider that is on first",
  not_eligible:
    "The emergency admin must be an owner who is on and has a password",
};

const refused = (reason: Refusal) =>
  new SessionServiceError("REVISION_CONFLICT", REFUSED[reason], undefined, {
    reason_code: reason,
  });

const viewOf = (record: LoginSettingsRecord): LoginSettingsView => ({
  password_login: record.passwordLogin,
  emergency_admin: record.emergencyAdmin && {
    user_id: record.emergencyAdmin.userId,
    email: record.emergencyAdmin.email,
    display_name: record.emergencyAdmin.displayName,
    eligible: record.emergencyAdmin.eligible,
  },
  enabled_providers: record.enabledProviders,
});

/**
 * The owner's password switch and emergency admin (design 9). Both methods
 * re-check the caller; the store refuses a change that would leave nobody,
 * or the owner asking, a way in.
 */
export function createLoginSettingsAdmin(deps: {
  authorization: AuthorizationPolicy;
  store: LoginSettingsStore;
}) {
  return {
    async read(caller: Caller): Promise<LoginSettingsView> {
      await requireSignInOwner(deps.authorization, caller);
      return viewOf(await deps.store.read());
    },

    async change(
      caller: Caller,
      change: UpdateLoginSettingsRequest,
    ): Promise<UpdateLoginSettingsResponse> {
      const audit = await requireSignInOwner(deps.authorization, caller);
      const { password_login: value, emergency_admin_user_id: userId } = change;
      // The request schema lets through exactly one of the two.
      if ((value === undefined) === (userId === undefined)) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "Name exactly one field to change",
        );
      }
      const result =
        value !== undefined
          ? await deps.store.setPasswordLogin({ value, audit })
          : await deps.store.setEmergencyAdmin({
              userId: userId as string,
              audit,
            });
      if (result.outcome !== "changed" && result.outcome !== "unchanged") {
        throw refused(result.outcome);
      }
      return {
        settings: viewOf(result.settings),
        sessions_revoked:
          result.outcome === "changed" ? result.sessionsRevoked : 0,
      };
    },
  };
}

export type LoginSettingsAdmin = ReturnType<typeof createLoginSettingsAdmin>;
