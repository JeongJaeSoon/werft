import {
  carriedDeny,
  denyOf,
  mcpNamesOf,
  type ToolCatalogView,
  toolsUnder,
} from "./profile-tools.ts";
import type { PERMISSION_MODE_VALUES } from "./session.ts";

type PermissionMode = (typeof PERMISSION_MODE_VALUES)[number];

/** The fields a workspace profile version sets over its operator base. */
export type DerivedFields = {
  readonly model: string;
  readonly models: readonly string[];
  readonly tools: readonly string[];
  readonly permission_mode: PermissionMode;
  /**
   * The built-in tools it blocks, base's included, when worked out against
   * a tool catalog. Never read by `refusal` or `apply`: those follow `tools`.
   */
  readonly deny?: readonly string[] | null | undefined;
};

/** What a policy reads of a base: an operator profile, in the catalog or listed. */
export type DerivationBase = {
  readonly model: string;
  readonly models?: readonly string[] | undefined;
  readonly tools: readonly string[];
  readonly permission_mode: PermissionMode;
  /** The `mcp__` names the base blocks, sorted; absent when none. */
  readonly mcp_deny?: readonly string[] | undefined;
};

/**
 * Whether `derived` leaves out an `mcp__` name its base blocks. Worked out
 * from the deny a save would store, not from how the request was spelled.
 */
export function mcpDenyDropped(
  base: Pick<DerivationBase, "mcp_deny">,
  derived: { readonly deny?: readonly string[] | null | undefined },
): boolean {
  const kept = new Set(derived.deny ?? []);
  return (base.mcp_deny ?? []).some((name) => !kept.has(name));
}

export type DerivationRefusal = {
  readonly field: Exclude<keyof DerivedFields, "deny">;
  readonly message: string;
};

/**
 * How a workspace profile version may differ from its base. The server checks
 * a save and a running version with `refusal` and runs `apply`; the console
 * starts from `initial` or `carry` and offers `choices`.
 */
export interface ProfileDerivationPolicy {
  readonly kind: string;
  /**
   * The values a new version starts from: `auto` where the base allows it.
   * Given the base's tool catalog, also its `deny` (what the base blocks)
   * and the `tools` a save of that deny stores.
   */
  initial(base: DerivationBase, catalog?: ToolCatalogView): DerivedFields;
  /**
   * An earlier version's values, kept where the base still allows them.
   * Given the base's tool catalog, also its `deny`: the earlier version's,
   * the base's, and every tool the earlier version never weighed.
   */
  carry(
    previous: DerivedFields,
    base: DerivationBase,
    catalog?: ToolCatalogView,
  ): DerivedFields;
  /**
   * What each field may take over this base. Given the base's tool catalog,
   * also what `deny` may name and what it must keep (`fixed`, the base's).
   */
  choices(
    base: DerivationBase,
    catalog?: ToolCatalogView,
  ): {
    readonly models: readonly string[];
    readonly tools: readonly string[];
    readonly permission_modes: readonly PermissionMode[];
    readonly deny?: {
      readonly names: readonly string[];
      readonly fixed: readonly string[];
    };
  };
  /** Why `derived` leaves what the base allows, naming the field, or null. */
  refusal(
    base: DerivationBase,
    derived: DerivedFields,
  ): DerivationRefusal | null;
  /**
   * The base as the version runs it. Listing applies it to every stored
   * version whose base still exists, whether or not it passes `refusal`.
   */
  apply<B extends DerivationBase>(base: B, derived: DerivedFields): B;
}

/**
 * The permission modes a version may run under a base of each mode: the
 * base's own, or one that leaves more to a person. A version never runs
 * unattended over an attended base.
 */
const NARROWER_PERMISSION_MODES: Readonly<
  Record<PermissionMode, readonly PermissionMode[]>
> = {
  bypassPermissions: [
    "bypassPermissions",
    "auto",
    "acceptEdits",
    "default",
    "plan",
  ],
  auto: ["auto", "acceptEdits", "default", "plan"],
  acceptEdits: ["acceptEdits", "default", "plan"],
  default: ["default", "plan"],
  dontAsk: ["dontAsk", "plan"],
  plan: ["plan"],
};

const offeredModels = (base: DerivationBase): string[] => [
  ...new Set([base.model, ...(base.models ?? [])]),
];

/** The base's own deny joins the previous version's: a version only adds blocks. */
function versionDeny(
  previous: DerivedFields,
  base: DerivationBase,
  catalog: ToolCatalogView,
): string[] {
  const blocked = new Set([
    ...denyOf(catalog, base.tools),
    ...carriedDeny(catalog, previous),
  ]);
  return catalog.tools
    .map((tool) => tool.name)
    .filter((name) => blocked.has(name));
}

/** Every value is the base's or narrower: fewer models and tools, a stricter mode. */
export const narrowOnlyPolicy: ProfileDerivationPolicy = {
  kind: "narrow",
  initial(base, catalog) {
    const deny = catalog === undefined ? [] : denyOf(catalog, base.tools);
    return {
      model: base.model,
      models: [base.model],
      tools:
        catalog === undefined
          ? [...base.tools]
          : toolsUnder(catalog, deny, base.tools),
      permission_mode: NARROWER_PERMISSION_MODES[base.permission_mode].includes(
        "auto",
      )
        ? "auto"
        : base.permission_mode,
      ...(catalog === undefined ? {} : { deny }),
    };
  },
  carry(previous, base, catalog) {
    const offered = offeredModels(base);
    const models = previous.models.filter((model) => offered.includes(model));
    const deny =
      catalog === undefined ? [] : versionDeny(previous, base, catalog);
    return {
      model: models.includes(previous.model)
        ? previous.model
        : (models[0] ?? base.model),
      models: models.length > 0 ? models : [base.model],
      tools:
        catalog === undefined
          ? previous.tools.filter((tool) => base.tools.includes(tool))
          : toolsUnder(catalog, deny, base.tools),
      permission_mode: NARROWER_PERMISSION_MODES[base.permission_mode].includes(
        previous.permission_mode,
      )
        ? previous.permission_mode
        : base.permission_mode,
      ...(catalog === undefined ? {} : { deny }),
    };
  },
  choices: (base, catalog) => ({
    models: offeredModels(base),
    tools: base.tools,
    permission_modes: NARROWER_PERMISSION_MODES[base.permission_mode],
    ...(catalog === undefined
      ? {}
      : {
          deny: {
            names: catalog.tools.map((tool) => tool.name),
            fixed: denyOf(catalog, base.tools),
          },
        }),
  }),
  refusal(base, derived) {
    const offered = offeredModels(base);
    const unknownModel = derived.models.find((m) => !offered.includes(m));
    if (unknownModel !== undefined) {
      return {
        field: "models",
        message: `The base profile does not offer model ${unknownModel}`,
      };
    }
    if (!derived.models.includes(derived.model)) {
      return { field: "model", message: "model must be one of models" };
    }
    const unknownTool = derived.tools.find((t) => !base.tools.includes(t));
    if (unknownTool !== undefined) {
      return {
        field: "tools",
        message: `The base profile does not allow tool ${unknownTool}`,
      };
    }
    const modes = NARROWER_PERMISSION_MODES[base.permission_mode];
    if (!modes.includes(derived.permission_mode)) {
      return {
        field: "permission_mode",
        message: `A profile over a ${base.permission_mode} base may run ${modes.join(", ")}`,
      };
    }
    return null;
  },
  apply(base, derived) {
    // The base's blocks always stay, even ones it gained after this version.
    const mcp_deny = mcpNamesOf([
      ...(base.mcp_deny ?? []),
      ...(derived.deny ?? []),
    ]);
    const { mcp_deny: _kept, ...rest } = base;
    return {
      ...rest,
      model: derived.model,
      models: [...derived.models],
      tools: [...derived.tools],
      permission_mode: derived.permission_mode,
      ...(mcp_deny.length > 0 ? { mcp_deny } : {}),
    } as unknown as typeof base;
  },
};

/** The one place the server and the console pick the policy versions follow. */
export const WORKSPACE_PROFILE_POLICY: ProfileDerivationPolicy =
  narrowOnlyPolicy;
