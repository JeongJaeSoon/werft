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
  offersSkills(runtimeKind: RuntimeKind): boolean;
};

const refOf = (bundle: ExtensionBundle): ExtensionRef => ({
  bundleId: bundle.id,
  name: bundle.name,
  digest: bundle.digest,
  manifest: bundle.manifest,
});

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

export async function resolveSessionExtensions(
  deps: SessionExtensionsDeps,
  input: {
    workspaceId: string;
    agentId: string | null;
    selection?: {
      enable?: readonly string[] | undefined;
      disable?: readonly string[] | undefined;
    };
    runtimeKind: RuntimeKind;
    tools: readonly string[];
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
    runtimeOffersSkills: deps.offersSkills(input.runtimeKind),
    tools: input.tools,
  });
}

export async function checkPinnedExtensions(
  deps: SessionExtensionsDeps,
  input: {
    workspaceId: string;
    extensions: readonly { bundle_id: string }[] | null;
    runtimeKind: RuntimeKind;
    tools: readonly string[];
  },
): Promise<ExtensionResolution> {
  const workspace: ScopeEntry[] = [];
  for (const pinned of input.extensions ?? []) {
    const bundle = await deps.store.find(input.workspaceId, pinned.bundle_id);
    if (!bundle) {
      return {
        ok: false,
        refusal: {
          code: "bundle_not_found",
          name: pinned.bundle_id,
          message: `Bundle ${pinned.bundle_id} the session runs with is no longer registered`,
        },
      };
    }
    // A scripts bundle runs code, and what let it run on any profile was its
    // review, not the profile's mode: a bundle whose approval was withdrawn
    // since the session pinned it does not follow the session to a new profile.
    if (
      bundle.review !== "approved" &&
      bundle.manifest.skills.some((skill) => skill.has_scripts)
    ) {
      return {
        ok: false,
        refusal: {
          code: "bundle_not_approved",
          name: bundle.name,
          message: `"${bundle.name}" carries skills with scripts, and its registered version is not approved`,
        },
      };
    }
    workspace.push({ mode: "required", ref: refOf(bundle) });
  }
  return resolveExtensions({
    scopes: { workspace },
    runtimeOffersSkills: deps.offersSkills(input.runtimeKind),
    tools: input.tools,
  });
}

export async function checkAgentExtensions(
  deps: SessionExtensionsDeps,
  input: {
    workspaceId: string;
    agentId: string;
    runtimeKind: RuntimeKind;
    tools: readonly string[];
  },
): Promise<ExtensionResolution> {
  const scopes = await scopesOf(deps, input.workspaceId, input.agentId);
  if (isResolution(scopes)) return scopes;
  return resolveExtensions({
    scopes,
    runtimeOffersSkills: deps.offersSkills(input.runtimeKind),
    tools: input.tools,
    includeOptional: true,
  });
}
