import type { RuntimeKind } from "@werft-ai/contracts";
import type {
  ExtensionBundle,
  ExtensionBundleStore,
} from "../ports/extension-bundle-store.ts";
import {
  type ExtensionRef,
  type ExtensionResolution,
  resolveExtensions,
  type ScopeEntry,
} from "./resolve.ts";

export type SessionExtensionsDeps = {
  store: Pick<ExtensionBundleStore, "find" | "listAttachments">;
  /** Whether the runtime of a profile offers skills (its descriptor is not `none`). */
  offersSkills(runtimeKind: RuntimeKind): boolean;
};

const refOf = (bundle: ExtensionBundle): ExtensionRef => ({
  bundleId: bundle.id,
  name: bundle.name,
  digest: bundle.digest,
  manifest: bundle.manifest,
});

/**
 * Only an approved bundle is offered: a `pending` or `rejected` row stays
 * registered but no session runs it. A `forbidden` entry needs no approval,
 * since it only keeps a name out.
 */
async function scopesOf(
  deps: SessionExtensionsDeps,
  workspaceId: string,
  agentId: string | null,
): Promise<
  { workspace: ScopeEntry[]; agent: ScopeEntry[] } | ExtensionResolution
> {
  const attachments = await deps.store.listAttachments({
    workspaceId,
    ...(agentId === null ? {} : { agentId }),
  });
  const scopes = { workspace: [] as ScopeEntry[], agent: [] as ScopeEntry[] };
  for (const attachment of attachments) {
    if (
      attachment.mode !== "forbidden" &&
      attachment.bundle.review !== "approved"
    ) {
      if (attachment.mode === "required") {
        return {
          ok: false,
          refusal: {
            code: "bundle_not_approved",
            name: attachment.bundle.name,
            message: `"${attachment.bundle.name}" is required but its registered version is not approved`,
          },
        };
      }
      continue;
    }
    scopes[attachment.scope].push({
      mode: attachment.mode,
      ref: refOf(attachment.bundle),
    });
  }
  return scopes;
}

function isResolution(
  value: { workspace: ScopeEntry[]; agent: ScopeEntry[] } | ExtensionResolution,
): value is ExtensionResolution {
  return "ok" in value;
}

/**
 * What a session creates with: the workspace's and the agent's bundles, then
 * the requester's own selection (bundle ids), folded by `resolveExtensions`.
 */
export async function resolveSessionExtensions(
  deps: SessionExtensionsDeps,
  input: {
    workspaceId: string;
    agentId: string | null;
    selection?: {
      enable?: readonly string[] | undefined;
      disable?: readonly string[] | undefined;
    };
    permissionMode: string;
    runtimeKind: RuntimeKind;
  },
): Promise<ExtensionResolution> {
  const scopes = await scopesOf(deps, input.workspaceId, input.agentId);
  if (isResolution(scopes)) return scopes;
  const refs = async (ids: readonly string[] | undefined) => {
    const found: ExtensionRef[] = [];
    for (const id of ids ?? []) {
      const bundle = await deps.store.find(input.workspaceId, id);
      if (!bundle) {
        return {
          refusal: {
            code: "bundle_not_found" as const,
            name: id,
            message: `Bundle ${id} is not registered in this workspace`,
          },
        };
      }
      found.push(refOf(bundle));
    }
    return { found };
  };
  const enable = await refs(input.selection?.enable);
  if ("refusal" in enable) return { ok: false, refusal: enable.refusal };
  const disable = await refs(input.selection?.disable);
  if ("refusal" in disable) return { ok: false, refusal: disable.refusal };
  return resolveExtensions({
    scopes,
    session: { enable: enable.found, disable: disable.found },
    permissionMode: input.permissionMode,
    runtimeOffersSkills: deps.offersSkills(input.runtimeKind),
  });
}

/**
 * The activation-time question for an agent on a release's profile: could
 * every bundle a session might turn on run there? A failure is a refusal to
 * activate, not a session that fails later.
 */
export async function checkAgentExtensions(
  deps: SessionExtensionsDeps,
  input: {
    workspaceId: string;
    agentId: string;
    permissionMode: string;
    runtimeKind: RuntimeKind;
  },
): Promise<ExtensionResolution> {
  const scopes = await scopesOf(deps, input.workspaceId, input.agentId);
  if (isResolution(scopes)) return scopes;
  return resolveExtensions({
    scopes,
    permissionMode: input.permissionMode,
    runtimeOffersSkills: deps.offersSkills(input.runtimeKind),
    includeOptional: true,
  });
}
