import type { RuntimeKind } from "@werft-ai/contracts";
import type { SkillCalling } from "@werft-ai/runtime-core";
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
  skillCalling(runtimeKind: RuntimeKind): SkillCalling | null;
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
    // Switched off or withdrawn: a new session starts without it, even when
    // it is required. One already running keeps the version it pinned.
    if (attachment.availability !== "ok" && attachment.mode !== "forbidden") {
      continue;
    }
    // A following row is the skill's current version as of this start.
    if (attachment.bundle === null) {
      if (attachment.mode === "required") {
        return {
          ok: false,
          refusal: {
            code: "no_current_version",
            name: attachment.name,
            message: `"${attachment.name}" is required but the skill has no current version`,
          },
        };
      }
      continue;
    }
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
    skills: deps.skillCalling(input.runtimeKind),
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
    skills: deps.skillCalling(input.runtimeKind),
    tools: input.tools,
    includeOptional: true,
  });
}
