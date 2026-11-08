import type { AgentCard, AgentRelease } from "@werft-ai/contracts";

export const RELEASE_AREAS = [
  "repositories",
  "model",
  "tools",
  "prompt",
  "settings",
  "secrets",
] as const;
export type ReleaseArea = (typeof RELEASE_AREAS)[number];

/** A field named by its `agent.releases.field.*` key, or a config path. */
export type ReleaseField = { readonly key: string } | { readonly path: string };

export type ReleaseChange = {
  readonly area: ReleaseArea;
  readonly field: ReleaseField;
} & (
  | {
      readonly kind: "list";
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }
  | {
      readonly kind: "value";
      /** Null is the field's absence: see `agent.releases.absent.*`. */
      readonly before: string | null;
      readonly after: string | null;
    }
  | { readonly kind: "text"; readonly before: string; readonly after: string }
  // A credential, or a value not known to be safe or readable: no value shown.
  | { readonly kind: "changed" }
);

/** The same agent's release made just before this one, by creation. */
export function previousRelease(
  releases: readonly AgentRelease[],
  release: AgentRelease,
): AgentRelease | undefined {
  const ordered = [...releases].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const at = ordered.findIndex((item) => item.id === release.id);
  return at > 0 ? ordered[at - 1] : undefined;
}

// A snapshot's credentials travel only by reference (`*_ref`), but its key
// check cannot see a credential under a name that says nothing, so only the
// paths the release builder writes show their values.
const READABLE_CONFIG =
  /^(permission_mode|provider\.(kind|endpoint)|project_settings(\..+)?)$/;
// The contracts' key words (`apiKeyRef` → api Key Ref, `API_KEY_REF` → API
// KEY REF), and their words for a credential or a reference to one.
const SECRET_WORD =
  /^(refs?|keys?|tokens?|secrets?|passwords?|passphrase|credentials?)$/i;
const SECRET_WHOLE_KEY = /^(auth|authorization|env|environment|headers)$/i;
const secretKey = (key: string) =>
  SECRET_WHOLE_KEY.test(key) ||
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .some((word) => SECRET_WORD.test(word));

const noFeatures = (features: Record<string, boolean> | undefined) =>
  Object.fromEntries(Object.keys(features ?? {}).map((key) => [key, false]));

/** Whether a key anywhere inside names a credential. */
function holdsSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsSecret);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) => secretKey(key) || holdsSecret(nested),
  );
}

const shown = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** Leaf values by dotted path; an array or an empty object is a leaf. */
function leaves(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.keys(value).length === 0 && prefix !== "")
  ) {
    if (prefix !== "") out.set(prefix, value);
    return out;
  }
  for (const [key, nested] of Object.entries(value)) {
    for (const [path, leaf] of leaves(
      nested,
      prefix === "" ? key : `${prefix}.${key}`,
    ))
      out.set(path, leaf);
  }
  return out;
}

function listChange(
  area: ReleaseArea,
  key: string,
  before: readonly string[],
  after: readonly string[],
): ReleaseChange[] {
  const added = after.filter((item) => !before.includes(item));
  const removed = before.filter((item) => !after.includes(item));
  return added.length === 0 && removed.length === 0
    ? []
    : [{ area, field: { key }, kind: "list", added, removed }];
}

/**
 * A list that may be absent, where absence means something else than empty:
 * a list change while both are present, else a value change from or to null.
 */
function optionalListChange(
  area: ReleaseArea,
  key: string,
  before: readonly string[] | null,
  after: readonly string[] | null,
): ReleaseChange[] {
  if (before !== null && after !== null)
    return listChange(area, key, before, after);
  return before === after
    ? []
    : [
        {
          area,
          field: { key },
          kind: "value",
          before: before === null ? null : before.join(", "),
          after: after === null ? null : after.join(", "),
        },
      ];
}

function valueChange(
  area: ReleaseArea,
  field: ReleaseField,
  before: unknown,
  after: unknown,
): ReleaseChange[] {
  const a = before === undefined || before === null ? null : shown(before);
  const b = after === undefined || after === null ? null : shown(after);
  return a === b ? [] : [{ area, field, kind: "value", before: a, after: b }];
}

function leafChanges(
  area: ReleaseArea,
  prefix: string,
  before: unknown,
  after: unknown,
  readable: (path: string) => boolean,
): ReleaseChange[] {
  const a = leaves(before ?? {});
  const b = leaves(after ?? {});
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  return paths.flatMap((path): ReleaseChange[] => {
    if (
      a.has(path) === b.has(path) &&
      shown(a.get(path)) === shown(b.get(path))
    )
      return [];
    const field = { path: prefix === "" ? path : `${prefix}.${path}` };
    if (
      path.split(".").some(secretKey) ||
      holdsSecret(a.get(path)) ||
      holdsSecret(b.get(path))
    )
      return [{ area: "secrets", field, kind: "changed" }];
    if (!readable(path)) return [{ area, field, kind: "changed" }];
    return valueChange(area, field, a.get(path), b.get(path));
  });
}

/**
 * What `after` changed against `before`, in RELEASE_AREAS order. Each
 * release is read with the card of its own version; a release whose version
 * is missing compares without its card.
 */
export function releaseChanges(
  before: AgentRelease,
  after: AgentRelease,
  cardOf: (versionId: string) => AgentCard | undefined,
): ReleaseChange[] {
  const cardA = cardOf(before.version_id);
  const cardB = cardOf(after.version_id);
  const githubA = before.policy_pins.github;
  const githubB = after.policy_pins.github;
  const toolsA = before.policy_pins.tools;
  const toolsB = after.policy_pins.tools;
  const perTool = (pins: typeof toolsA) =>
    Object.entries(pins?.per_tool ?? {}).map(
      ([tool, mode]) => `${tool}: ${mode}`,
    );
  const workflows = (github: typeof githubA) =>
    (github?.actions_allow ?? []).map((rule) =>
      rule.ref === undefined ? rule.workflow : `${rule.workflow}@${rule.ref}`,
    );
  // The snapshot's model and tools are compared as their own fields.
  const {
    model: modelA,
    tools: _toolsA,
    ...configA
  } = before.runtime_config_snapshot;
  const {
    model: modelB,
    tools: _toolsB,
    ...configB
  } = after.runtime_config_snapshot;
  const instructionsA = cardA?.agent_instructions ?? "";
  const instructionsB = cardB?.agent_instructions ?? "";
  const changes: ReleaseChange[] = [
    // No GitHub pin is every repository the profile allows, not none.
    ...optionalListChange(
      "repositories",
      "repositories",
      githubA?.repositories ?? null,
      githubB?.repositories ?? null,
    ),
    ...valueChange(
      "repositories",
      { key: "defaultRepository" },
      before.repository_id,
      after.repository_id,
    ),
    ...valueChange(
      "model",
      { key: "model" },
      modelA ?? cardA?.model,
      modelB ?? cardB?.model,
    ),
    ...listChange(
      "tools",
      "tools",
      before.effective_tools.tools,
      after.effective_tools.tools,
    ),
    // The MCP server, its tools and the credential names are the agent's
    // settings, saved apart from a release (the Access tab), so a release
    // does not list them.
    ...leafChanges(
      "tools",
      "tool_policy.default",
      toolsA?.default,
      toolsB?.default,
      () => true,
    ),
    ...listChange("tools", "toolPolicy", perTool(toolsA), perTool(toolsB)),
    // What a run appends to its system prompt; rules and language stay on the card.
    ...(instructionsA === instructionsB
      ? []
      : [
          {
            area: "prompt",
            field: { key: "instructions" },
            kind: "text",
            before: instructionsA,
            after: instructionsB,
          } as const,
        ]),
    ...valueChange(
      "settings",
      { key: "profile" },
      before.runtime_profile_id,
      after.runtime_profile_id,
    ),
    // Profile values the snapshot leaves out change only this digest.
    ...(before.profile_digest === after.profile_digest
      ? []
      : [
          {
            area: "settings",
            field: { key: "profileDigest" },
            kind: "changed",
          } as const,
        ]),
    ...leafChanges("settings", "", configA, configB, (path) =>
      READABLE_CONFIG.test(path),
    ),
    // A release without the pin runs as one with every person approving
    // each push and no optional permission (policyPinsSchema).
    ...valueChange(
      "settings",
      { key: "pushApproval" },
      githubA?.push_approval ?? true,
      githubB?.push_approval ?? true,
    ),
    ...leafChanges(
      "settings",
      "github.features",
      githubA?.features ?? noFeatures(githubB?.features),
      githubB?.features ?? noFeatures(githubA?.features),
      () => true,
    ),
    ...listChange(
      "settings",
      "actionsAllow",
      workflows(githubA),
      workflows(githubB),
    ),
    ...listChange(
      "settings",
      "rules",
      (cardA?.rules ?? []).map((rule) => rule.text),
      (cardB?.rules ?? []).map((rule) => rule.text),
    ),
    ...valueChange(
      "settings",
      { key: "language" },
      cardA?.language,
      cardB?.language,
    ),
  ];
  // A card field no row above reads, such as a legacy `instructions`.
  if (changes.length === 0 && before.card_sha256 !== after.card_sha256)
    changes.push({ area: "settings", field: { key: "card" }, kind: "changed" });
  return RELEASE_AREAS.flatMap((area) =>
    changes.filter((change) => change.area === area),
  );
}
