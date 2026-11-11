import {
  GITHUB_LINK_TENANT,
  LINK_MESSAGES,
  LINKED_ACCOUNT_LIST_LIMIT,
  type LinkedAccount,
  type ListLinkedAccountsResponse,
  type SlackLinkCallbackResponse,
  type UnlinkAccountResponse,
} from "@werft-ai/contracts";
import type {
  LinkedAccountRecord,
  LinkedAccountStore,
} from "../ports/linked-account-store.ts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";
import { SessionServiceError } from "./service-errors.ts";

function linkedAccountView(record: LinkedAccountRecord): LinkedAccount {
  return {
    id: record.id,
    user_id: record.userId,
    provider: record.provider,
    external_tenant: record.externalTenant,
    external_user_id: record.externalUserId,
    external_tenant_name: record.externalTenantName,
    external_user_name: record.externalUserName,
    status: record.status,
    verified_at: record.verifiedAt.toISOString(),
    revision: record.revision,
    // Neither Slack nor GitHub keeps a token.
    expires_at: null,
  };
}

/**
 * A person linking their own accounts (design 3.1). Every call goes through
 * `account.link`, which only a person's web session holds: an API key, even
 * a personal one, cannot link or unlink on its holder's behalf.
 */
export function createLinkedAccountService(deps: {
  authorization: AuthorizationPolicy;
  store: LinkedAccountStore;
}) {
  const { authorization, store } = deps;

  async function permittedPerson(caller: Caller): Promise<string> {
    await requirePermitted(authorization, caller, "account.link", {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    if (!userId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "This principal does not hold account.link",
      );
    }
    return userId;
  }

  return {
    /** The person a link would belong to; refuses anyone else. */
    personFor: permittedPerson,

    /**
     * Who is linking and the teams the account may come from; refuses
     * before Slack is ever shown.
     */
    async beginSlackLink(
      caller: Caller,
    ): Promise<{ userId: string; teams: string[] }> {
      const userId = await permittedPerson(caller);
      const teams = await store.installedSlackTeams(caller.ownerId);
      if (teams.length === 0) {
        throw new SessionServiceError(
          "SLACK_NOT_INSTALLED",
          LINK_MESSAGES.notInstalled,
        );
      }
      return { userId, teams };
    },

    /** Every field comes from an id_token the caller verified. */
    async linkSlackAccount(
      caller: Caller,
      verified: {
        teamId: string;
        userId: string;
        teamName: string | null;
        userName: string | null;
      },
    ): Promise<SlackLinkCallbackResponse> {
      const userId = await permittedPerson(caller);
      const result = await store.link({
        principal: caller,
        workspaceId: caller.ownerId,
        userId,
        account: {
          provider: "slack",
          externalTenant: verified.teamId,
          externalUserId: verified.userId,
        },
        names: {
          externalTenantName: verified.teamName,
          externalUserName: verified.userName,
        },
      });
      switch (result.outcome) {
        case "linked":
          return {
            linked_account: linkedAccountView(result.account),
            receipt_id: result.receiptId,
          };
        case "not_installed":
          throw new SessionServiceError(
            "SLACK_NOT_INSTALLED",
            LINK_MESSAGES.notInstalled,
          );
        case "team_mismatch":
          throw new SessionServiceError(
            "LINK_TEAM_MISMATCH",
            LINK_MESSAGES.teamMismatch(result.workspaceName),
          );
        case "taken":
          throw new SessionServiceError("LINK_TAKEN", LINK_MESSAGES.taken);
        case "exists":
          throw new SessionServiceError("LINK_EXISTS", LINK_MESSAGES.exists);
        default:
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal is no longer a member of the workspace",
          );
      }
    },

    /** Every field comes from GitHub's answer to the caller's own code. */
    async linkGitHubAccount(
      caller: Caller,
      verified: { id: string; login: string },
    ): Promise<SlackLinkCallbackResponse> {
      const userId = await permittedPerson(caller);
      const result = await store.link({
        principal: caller,
        workspaceId: caller.ownerId,
        userId,
        account: {
          provider: "github",
          externalTenant: GITHUB_LINK_TENANT,
          externalUserId: verified.id,
        },
        names: {
          externalTenantName: "GitHub",
          externalUserName: verified.login,
        },
      });
      switch (result.outcome) {
        case "linked":
          return {
            linked_account: linkedAccountView(result.account),
            receipt_id: result.receiptId,
          };
        case "taken":
          throw new SessionServiceError(
            "LINK_TAKEN",
            LINK_MESSAGES.githubTaken,
          );
        case "exists":
          throw new SessionServiceError(
            "LINK_EXISTS",
            LINK_MESSAGES.githubExists,
          );
        default:
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal is no longer a member of the workspace",
          );
      }
    },

    async listLinkedAccounts(
      caller: Caller,
    ): Promise<ListLinkedAccountsResponse> {
      const userId = await permittedPerson(caller);
      const rows = await store.list(
        caller.ownerId,
        userId,
        LINKED_ACCOUNT_LIST_LIMIT,
      );
      return { items: rows.map(linkedAccountView) };
    },

    async unlinkAccount(
      caller: Caller,
      linkedAccountId: string,
    ): Promise<UnlinkAccountResponse> {
      const userId = await permittedPerson(caller);
      const result = await store.unlink({
        principal: caller,
        workspaceId: caller.ownerId,
        userId,
        linkedAccountId,
      });
      if (result.outcome === "not_found") {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return { receipt_id: result.receiptId, receipt_status: "succeeded" };
    },
  };
}

export type LinkedAccountService = ReturnType<
  typeof createLinkedAccountService
>;
