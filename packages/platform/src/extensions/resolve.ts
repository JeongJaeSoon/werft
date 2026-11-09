import type { BundleManifest } from "./bundle-validator.ts";

export const EXTENSION_MODES = ["required", "optional", "forbidden"] as const;
export type ExtensionMode = (typeof EXTENSION_MODES)[number];

/** Outermost first: a later scope can only narrow what an earlier one set. */
export const EXTENSION_SCOPES = [
  "profile",
  "workspace",
  "agent",
  "session",
] as const;
export type ExtensionScope = (typeof EXTENSION_SCOPES)[number];

/** The bundle version a scope names. A digest is one version of a name. */
export type ExtensionRef = {
  bundleId: string;
  name: string;
  digest: string;
  manifest: BundleManifest;
};

/** What one scope says about one bundle name. `forbidden` needs no version. */
export type ScopeEntry = {
  mode: ExtensionMode;
  ref: ExtensionRef;
};

/** What the session's requester turns on or off; only `optional` names qualify. */
export type SessionSelection = {
  enable: readonly ExtensionRef[];
  disable: readonly ExtensionRef[];
};

export type ResolvedExtension = {
  bundleId: string;
  name: string;
  digest: string;
  /** The scope that put it in the list. */
  scope: ExtensionScope;
};

export type ExtensionRefusalCode =
  | "required_removed"
  | "required_replaced"
  | "forbidden_revived"
  | "not_optional"
  | "bundle_not_found"
  | "bundle_not_approved"
  | "skill_name_collision"
  | "feature_unsupported"
  | "scripts_need_default_mode";

export type ExtensionRefusal = {
  code: ExtensionRefusalCode;
  /** The bundle name the refusal is about. */
  name: string;
  message: string;
};

export type ExtensionResolution =
  | { ok: true; extensions: ResolvedExtension[] }
  | { ok: false; refusal: ExtensionRefusal };

type State = {
  mode: ExtensionMode;
  ref: ExtensionRef;
  scope: ExtensionScope;
  enabled: boolean;
};

const refuse = (
  code: ExtensionRefusalCode,
  name: string,
  message: string,
): ExtensionResolution => ({ ok: false, refusal: { code, name, message } });

/**
 * Folds the scopes, outermost first, into the bundle list a session runs
 * with (94S-867). The result is written to the session row once; nothing
 * re-reads the scopes for that session afterwards.
 *
 * - A `required` bundle stays required, at the version the outer scope
 *   named; an inner scope cannot forbid, relax or re-version it.
 * - A `forbidden` name stays forbidden; an inner scope cannot revive it.
 * - `optional` is off until the session turns it on, and the session can
 *   turn on or off only what a scope left `optional`.
 * - Two versions of one name in one scope are a skill-name collision: the
 *   engine sees skills as `<name>:<skill>`, so a name is the unit.
 *
 * `includeOptional` is the activation-time question: would every bundle a
 * session could turn on be allowed on this profile?
 */
export function resolveExtensions(input: {
  scopes: Partial<Record<Exclude<ExtensionScope, "session">, ScopeEntry[]>>;
  session?: SessionSelection;
  permissionMode: string;
  /** Whether the profile's runtime offers skills (descriptor not `none`). */
  runtimeOffersSkills: boolean;
  includeOptional?: boolean;
}): ExtensionResolution {
  const states = new Map<string, State>();

  for (const scope of EXTENSION_SCOPES) {
    if (scope === "session") break;
    const entries = input.scopes[scope] ?? [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const name = entry.ref.name;
      if (seen.has(name)) {
        return refuse(
          "skill_name_collision",
          name,
          `The ${scope} scope names two versions of "${name}"`,
        );
      }
      seen.add(name);
      const outer = states.get(name);
      if (outer?.mode === "forbidden" && entry.mode !== "forbidden") {
        return refuse(
          "forbidden_revived",
          name,
          `"${name}" is forbidden by the ${outer.scope} scope; the ${scope} scope cannot bring it back`,
        );
      }
      if (outer?.mode === "required") {
        if (entry.mode !== "required") {
          return refuse(
            "required_removed",
            name,
            `"${name}" is required by the ${outer.scope} scope; the ${scope} scope cannot drop it`,
          );
        }
        if (entry.ref.digest !== outer.ref.digest) {
          return refuse(
            "required_replaced",
            name,
            `"${name}" is required by the ${outer.scope} scope at another version`,
          );
        }
        continue;
      }
      states.set(name, {
        mode: entry.mode,
        ref: entry.ref,
        scope,
        enabled: entry.mode === "required",
      });
    }
  }

  const selection = input.session;
  if (selection) {
    const named = new Set<string>();
    for (const [verb, refs] of [
      ["enable", selection.enable],
      ["disable", selection.disable],
    ] as const) {
      for (const ref of refs) {
        if (named.has(ref.name)) {
          return refuse(
            "skill_name_collision",
            ref.name,
            `The session names "${ref.name}" more than once`,
          );
        }
        named.add(ref.name);
        const state = states.get(ref.name);
        if (state?.mode === "forbidden") {
          return refuse(
            "forbidden_revived",
            ref.name,
            `"${ref.name}" is forbidden by the ${state.scope} scope`,
          );
        }
        if (!state || state.mode !== "optional") {
          return refuse(
            "not_optional",
            ref.name,
            state?.mode === "required"
              ? `"${ref.name}" is required by the ${state.scope} scope and cannot be turned off or on`
              : `"${ref.name}" is not offered to this session`,
          );
        }
        if (state.ref.digest !== ref.digest) {
          return refuse(
            "not_optional",
            ref.name,
            `"${ref.name}" is offered at another version than the one named`,
          );
        }
        state.enabled = verb === "enable";
        if (verb === "enable") state.scope = "session";
      }
    }
  }

  const applied: ResolvedExtension[] = [];
  const judged: State[] = [];
  for (const state of states.values()) {
    if (state.mode === "forbidden") continue;
    if (state.enabled) {
      judged.push(state);
    } else if (input.includeOptional && state.mode === "optional") {
      judged.push(state);
    }
    if (state.enabled) {
      applied.push({
        bundleId: state.ref.bundleId,
        name: state.ref.name,
        digest: state.ref.digest,
        scope: state.scope,
      });
    }
  }

  const skillNames = new Set<string>();
  for (const state of judged) {
    const skills = state.ref.manifest.skills;
    if (skills.length > 0 && !input.runtimeOffersSkills) {
      return refuse(
        "feature_unsupported",
        state.ref.name,
        `"${state.ref.name}" carries skills, which this profile's runtime does not offer`,
      );
    }
    if (
      skills.some((skill) => skill.has_scripts) &&
      input.permissionMode !== "default"
    ) {
      return refuse(
        "scripts_need_default_mode",
        state.ref.name,
        `"${state.ref.name}" carries skills with scripts, which run only on a profile in permission mode "default"`,
      );
    }
    for (const skill of skills) {
      const full = `${state.ref.name}:${skill.name}`;
      if (skillNames.has(full)) {
        return refuse(
          "skill_name_collision",
          state.ref.name,
          `Skill "${full}" is listed twice`,
        );
      }
      skillNames.add(full);
    }
  }

  applied.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, extensions: applied };
}
