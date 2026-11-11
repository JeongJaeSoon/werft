import type {
  ExportSettingsResponse,
  ImportSettingsResponse,
} from "@werft-ai/contracts";
import { requirePermitted, SessionServiceError } from "../musterrolle/index.ts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import type { SettingsDocumentStore } from "../ports/settings-document-store.ts";
import type { TeamActor } from "../ports/team-store.ts";
import {
  parseSettingsDocument,
  SettingsDocumentError,
  type SettingsEntries,
  settingsDocumentDigest,
  settingsDocumentOf,
} from "./settings-document.ts";

const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds installation.settings.manage",
    undefined,
    { reason_code: "role" },
  );

/**
 * The settings document through the API
 * (settings-replace-file-catalog.md §6): a signed-in owner exports it, and
 * imports one that brings no new env or Secrets Manager reference; those
 * only the operator's CLI brings in (§2).
 */
export function createSettingsDocumentService(deps: {
  authorization: AuthorizationPolicy;
  store: Pick<SettingsDocumentStore, "exportEntries" | "importEntries">;
  /** Reads the settings again after an import committed; never throws. */
  reread: () => Promise<void>;
}) {
  const { authorization, store } = deps;

  async function operator(caller: Caller): Promise<TeamActor> {
    await requirePermitted(
      authorization,
      caller,
      "installation.settings.manage",
      { kind: "workspace", id: caller.ownerId },
    );
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person exports or imports the installation settings",
        undefined,
        { reason_code: "role" },
      );
    }
    return { principal: caller, workspaceId, userId };
  }

  return {
    async export(caller: Caller): Promise<ExportSettingsResponse> {
      await operator(caller);
      const { entries, last4 } = await store.exportEntries();
      const document = settingsDocumentOf(entries, last4);
      return {
        document: document as ExportSettingsResponse["document"],
        digest: settingsDocumentDigest(document),
      };
    },

    async import(
      caller: Caller,
      document: unknown,
      options: { dryRun: boolean },
    ): Promise<ImportSettingsResponse> {
      const actor = await operator(caller);
      let entries: SettingsEntries;
      try {
        entries = parseSettingsDocument(document);
      } catch (error) {
        if (!(error instanceof SettingsDocumentError)) throw error;
        throw new SessionServiceError("BAD_REQUEST", error.message, undefined, {
          reason_code: "invalid_document",
        });
      }
      const result = await store.importEntries(entries, {
        dryRun: options.dryRun,
        allowExternal: false,
        actor,
      });
      if (result.outcome === "actor_inactive") throw OUTRANKED();
      if (result.outcome === "refused") {
        if (result.conflicts.length > 0) {
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "The document holds entries the installation already holds otherwise; nothing changed",
            undefined,
            { reason_code: "settings_conflict", entries: result.conflicts },
          );
        }
        throw new SessionServiceError(
          "BAD_REQUEST",
          "The document brings env or Secrets Manager references, which only the operator's settings CLI imports; nothing changed",
          undefined,
          {
            reason_code: "external_reference",
            entries: result.refused_external,
          },
        );
      }
      if (result.outcome === "applied" && result.add.length > 0) {
        await deps.reread();
      }
      return {
        outcome: result.outcome,
        added: result.add.map((add) => `${add.kind}:${add.id}`),
        unchanged: result.unchanged,
        inactive: result.inactive,
        needs_value: result.needs_value,
        receipt_ids: result.receipt_ids,
      };
    },
  };
}

export type SettingsDocumentService = ReturnType<
  typeof createSettingsDocumentService
>;
