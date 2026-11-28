import {
  checkSkillRepositoryResponseSchema,
  putSkillRepositoryRefRequestSchema,
  putSkillRepositoryRefResponseSchema,
  putSkillRepositorySkillSwitchRequestSchema,
  putSkillRepositorySkillSwitchResponseSchema,
  registerSkillRepositoryRequestSchema,
  registerSkillRepositoryResponseSchema,
  removeSkillRepositoryResponseSchema,
  skillRepositoryDetailSchema,
  skillRepositoryListSchema,
  skillRepositoryParamsSchema,
  skillRepositorySkillParamsSchema,
} from "@werft-ai/contracts";
import {
  SKILL_CHECK_LEASE_MS,
  type SkillRepositoryService,
  type SkillRepositoryServiceDeps,
  type SkillRepositoryStore,
} from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { beyondRequest } from "../../deadline.ts";
import { mapped, requireParams } from "../errors.ts";

/**
 * The store and the App lookup as a check uses them, each call under a
 * deadline of its own: a check whose request timed out while it read GitHub
 * or ran the gate still records what it found, runs the check queued behind
 * it and lets the repository go, and the check a ref change or a switch
 * turned on owes still starts. A check someone asked for starts only within
 * its request.
 */
export function listingBeyondRequest<
  S extends Pick<
    SkillRepositoryStore,
    | "begin"
    | "find"
    | "record"
    | "finish"
    | "skills"
    | "extend"
    | "recordSkillCheck"
  >,
  A extends unknown[],
  T,
>(store: S, apps: (...args: A) => Promise<T>) {
  return {
    store: {
      ...store,
      begin: ((workspaceId, id, trigger, leaseMs) =>
        (trigger.kind === "ref" || trigger.kind === "enable"
          ? beyondRequest(store.begin)
          : store.begin)(
          workspaceId,
          id,
          trigger,
          leaseMs,
        )) as SkillRepositoryStore["begin"],
      find: beyondRequest(store.find),
      record: beyondRequest(store.record),
      finish: beyondRequest(store.finish),
      skills: beyondRequest(store.skills),
      extend: beyondRequest(store.extend),
      recordSkillCheck: beyondRequest(store.recordSkillCheck),
    },
    apps: beyondRequest(apps),
  };
}

/**
 * A skill's version as a check registers it, under a deadline as long as the
 * check holds the repository for one skill: reading the version before it,
 * the gate, the secret scan and the write together outlast a request.
 */
export function checkBeyondRequest(
  bundles: SkillRepositoryServiceDeps["bundles"],
): SkillRepositoryServiceDeps["bundles"] {
  return { register: beyondRequest(bundles.register, SKILL_CHECK_LEASE_MS) };
}

export function registerSkillRepositoryRoutes(
  router: ApiRouter,
  service: SkillRepositoryService,
) {
  apiRoute(router, "listSkillRepositories", async (context) => {
    const listed = await mapped(() => service.list(context.get("caller")));
    return jsonWithSchema(context, skillRepositoryListSchema, listed);
  });

  apiRoute(router, "registerSkillRepository", async (context) => {
    const body = await parseJsonBody(
      context,
      registerSkillRepositoryRequestSchema,
    );
    const registered = await mapped(() =>
      service.register(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      registerSkillRepositoryResponseSchema,
      registered,
      201,
    );
  });

  apiRoute(router, "getSkillRepository", async (context) => {
    const params = requireParams(context, skillRepositoryParamsSchema);
    const found = await mapped(() =>
      service.get(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, skillRepositoryDetailSchema, found);
  });

  apiRoute(router, "removeSkillRepository", async (context) => {
    const params = requireParams(context, skillRepositoryParamsSchema);
    const removed = await mapped(() =>
      service.remove(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      removeSkillRepositoryResponseSchema,
      removed,
    );
  });

  apiRoute(router, "checkSkillRepository", async (context) => {
    const params = requireParams(context, skillRepositoryParamsSchema);
    const checked = await mapped(() =>
      service.checkNow(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, checkSkillRepositoryResponseSchema, checked);
  });

  apiRoute(router, "putSkillRepositoryRef", async (context) => {
    const params = requireParams(context, skillRepositoryParamsSchema);
    const body = await parseJsonBody(
      context,
      putSkillRepositoryRefRequestSchema,
    );
    const changed = await mapped(() =>
      service.setRef(context.get("caller"), params.id, body.ref),
    );
    return jsonWithSchema(
      context,
      putSkillRepositoryRefResponseSchema,
      changed,
    );
  });

  apiRoute(router, "putSkillRepositorySkillSwitch", async (context) => {
    const params = requireParams(context, skillRepositorySkillParamsSchema);
    const body = await parseJsonBody(
      context,
      putSkillRepositorySkillSwitchRequestSchema,
    );
    const changed = await mapped(() =>
      service.setSwitch(
        context.get("caller"),
        params.id,
        params.skill_id,
        body.enabled,
      ),
    );
    return jsonWithSchema(
      context,
      putSkillRepositorySkillSwitchResponseSchema,
      changed,
    );
  });
}
