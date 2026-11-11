import {
  ACHIEVEMENT_RULE_LIMIT,
  ACHIEVEMENT_TYPE_LIMIT,
  type AchievementCategoryChangeResponse,
  type AchievementJudgeChangeResponse,
  type AchievementJudgeResponse,
  type AchievementJudgeSettings,
  type AchievementRuleChangeResponse,
  type AchievementRuleRequest,
  type AchievementTypeChangeResponse,
  type CreateAchievementCategoryRequest,
  type CreateAchievementTypeRequest,
  type ListAchievementCategoriesResponse,
  type ListAchievementRulesResponse,
  type ListAchievementTypesResponse,
  type UpdateAchievementCategoryRequest,
  type UpdateAchievementTypeRequest,
} from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  NOT_FOUND,
  OUTRANKED,
  requirePermitted,
  SessionServiceError,
} from "../../musterrolle/index.ts";
import type { TeamActor } from "../../ports/team-store.ts";
import type { AchievementRuleStore } from "./achievement-store.ts";

const conflict = (reasonCode: string, message: string, extra = {}) =>
  new SessionServiceError("REVISION_CONFLICT", message, undefined, {
    reason_code: reasonCode,
    ...extra,
  });

const TYPE_IN_USE = () =>
  conflict("type_in_use", "Another rule in use already counts this type");

const UNKNOWN = {
  unknown_category: () =>
    new SessionServiceError(
      "BAD_REQUEST",
      "No such category, or it is archived",
      undefined,
      { reason_code: "unknown_category", field: "category_id" },
    ),
  unknown_type: () =>
    new SessionServiceError(
      "BAD_REQUEST",
      "No such achievement type, or it is archived",
      undefined,
      { reason_code: "unknown_type", field: "type_id" },
    ),
};

const RULE_LIMIT = () =>
  conflict(
    "limit_reached",
    `A workspace has at most ${ACHIEVEMENT_RULE_LIMIT} rules in use`,
    { limit: ACHIEVEMENT_RULE_LIMIT },
  );

export function createAchievementRuleService(deps: {
  authorization: AuthorizationPolicy;
  store: AchievementRuleStore;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function manager(caller: Caller): Promise<TeamActor> {
    await requirePermitted(authorization, caller, "achievement_rule.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person changes achievement rules",
        undefined,
        { reason_code: "role" },
      );
    }
    return { principal: caller, workspaceId, userId };
  }

  function workspaceOf(caller: Caller): string | null {
    return caller.actor?.workspaceId ?? null;
  }

  async function reader(caller: Caller): Promise<string | null> {
    await requirePermitted(authorization, caller, "workspace.read", {
      kind: "workspace",
      id: caller.ownerId,
    });
    return workspaceOf(caller);
  }

  // The path names a workspace; any other than the caller's does not exist.
  function sameWorkspace(caller: Caller, workspaceId: string): string {
    const own = workspaceOf(caller);
    if (own === null || own.toLowerCase() !== workspaceId.toLowerCase()) {
      throw NOT_FOUND();
    }
    return own;
  }

  return {
    async listCategories(
      caller: Caller,
    ): Promise<ListAchievementCategoriesResponse> {
      const workspaceId = await reader(caller);
      return {
        items:
          workspaceId === null ? [] : await store.listCategories(workspaceId),
      };
    },

    async createCategory(
      caller: Caller,
      request: CreateAchievementCategoryRequest,
    ): Promise<AchievementCategoryChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.createCategory({
        actor,
        receiptId,
        name: request.name,
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "name_taken":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            "A category by that name already exists in this workspace",
            undefined,
            { reason_code: "name_taken", field: "name" },
          );
        default:
          return { category: result.category, receipt_id: receiptId };
      }
    },

    async updateCategory(
      caller: Caller,
      categoryId: string,
      request: UpdateAchievementCategoryRequest,
    ): Promise<AchievementCategoryChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.updateCategory({
        actor,
        receiptId,
        categoryId,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.position === undefined
          ? {}
          : { position: request.position }),
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "not_found":
          throw NOT_FOUND();
        case "name_taken":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            "A category by that name already exists in this workspace",
            undefined,
            { reason_code: "name_taken", field: "name" },
          );
        default:
          return {
            category: result.category,
            receipt_id: result.outcome === "updated" ? receiptId : null,
          };
      }
    },

    async archiveCategory(
      caller: Caller,
      categoryId: string,
    ): Promise<AchievementCategoryChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.archiveCategory({
        actor,
        receiptId,
        categoryId,
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "not_found":
          throw NOT_FOUND();
        case "category_in_use":
          throw conflict(
            "category_in_use",
            "Rules in use remain in this category: move or disable them first",
          );
        default:
          return {
            category: result.category,
            receipt_id: result.outcome === "archived" ? receiptId : null,
          };
      }
    },

    async listTypes(caller: Caller): Promise<ListAchievementTypesResponse> {
      const workspaceId = await reader(caller);
      return {
        items: workspaceId === null ? [] : await store.listTypes(workspaceId),
      };
    },

    async createType(
      caller: Caller,
      request: CreateAchievementTypeRequest,
    ): Promise<AchievementTypeChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.createType({
        actor,
        receiptId,
        key: request.key,
        name: request.name,
        evidenceKind: request.evidence_kind,
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "key_taken":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            "An achievement type with that key already exists in this workspace",
            undefined,
            { reason_code: "key_taken", field: "key" },
          );
        case "limit_reached":
          throw conflict(
            "limit_reached",
            `A workspace has at most ${ACHIEVEMENT_TYPE_LIMIT} achievement types that are not archived`,
            { limit: ACHIEVEMENT_TYPE_LIMIT },
          );
        default:
          return { type: result.type, receipt_id: receiptId };
      }
    },

    async updateType(
      caller: Caller,
      typeId: string,
      request: UpdateAchievementTypeRequest,
    ): Promise<AchievementTypeChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.updateType({
        actor,
        receiptId,
        typeId,
        name: request.name,
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "not_found":
          throw NOT_FOUND();
        default:
          return {
            type: result.type,
            receipt_id: result.outcome === "updated" ? receiptId : null,
          };
      }
    },

    async archiveType(
      caller: Caller,
      typeId: string,
    ): Promise<AchievementTypeChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.archiveType({ actor, receiptId, typeId });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "not_found":
          throw NOT_FOUND();
        case "builtin":
          throw conflict("builtin", "A built-in type cannot be archived");
        case "type_in_use":
          throw TYPE_IN_USE();
        default:
          return {
            type: result.type,
            receipt_id: result.outcome === "archived" ? receiptId : null,
          };
      }
    },

    async listRules(caller: Caller): Promise<ListAchievementRulesResponse> {
      const workspaceId = await reader(caller);
      return {
        items: workspaceId === null ? [] : await store.listRules(workspaceId),
      };
    },

    async createRule(
      caller: Caller,
      request: AchievementRuleRequest,
    ): Promise<AchievementRuleChangeResponse> {
      return writeRule(caller, request, null);
    },

    async createRuleVersion(
      caller: Caller,
      familyId: string,
      request: AchievementRuleRequest,
    ): Promise<AchievementRuleChangeResponse> {
      return writeRule(caller, request, familyId);
    },

    async setRuleDisabled(
      caller: Caller,
      familyId: string,
      disabled: boolean,
    ): Promise<AchievementRuleChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.setRuleDisabled({
        actor,
        receiptId,
        familyId,
        disabled,
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "not_found":
          throw NOT_FOUND();
        case "type_in_use":
          throw TYPE_IN_USE();
        case "limit_reached":
          throw RULE_LIMIT();
        case "unknown_category":
        case "unknown_type":
          throw UNKNOWN[result.outcome]();
        default:
          return {
            rule: result.rule,
            receipt_id: result.outcome === "changed" ? receiptId : null,
          };
      }
    },

    async getJudge(
      caller: Caller,
      workspaceId: string,
    ): Promise<AchievementJudgeResponse> {
      const own = sameWorkspace(caller, workspaceId);
      await reader(caller);
      const settings = await store.getJudge(own);
      if (settings === null) throw NOT_FOUND();
      return { achievement_judge: settings };
    },

    async setJudge(
      caller: Caller,
      workspaceId: string,
      settings: AchievementJudgeSettings,
    ): Promise<AchievementJudgeChangeResponse> {
      sameWorkspace(caller, workspaceId);
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.setJudge({ actor, receiptId, settings });
      if (result.outcome === "actor_inactive") throw OUTRANKED();
      return { achievement_judge: result.settings, receipt_id: receiptId };
    },
  };

  async function writeRule(
    caller: Caller,
    request: AchievementRuleRequest,
    familyId: string | null,
  ): Promise<AchievementRuleChangeResponse> {
    const actor = await manager(caller);
    const receiptId = newId();
    const result =
      familyId === null
        ? await store.createRule({ actor, receiptId, rule: request })
        : await store.createRuleVersion({
            actor,
            receiptId,
            familyId,
            rule: request,
          });
    switch (result.outcome) {
      case "actor_inactive":
        throw OUTRANKED();
      case "not_found":
        throw NOT_FOUND();
      case "type_in_use":
        throw TYPE_IN_USE();
      case "limit_reached":
        throw RULE_LIMIT();
      case "unknown_category":
      case "unknown_type":
        throw UNKNOWN[result.outcome]();
      default:
        return { rule: result.rule, receipt_id: receiptId };
    }
  }
}

export type AchievementRuleService = ReturnType<
  typeof createAchievementRuleService
>;
