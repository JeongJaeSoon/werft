import type {
  GitHubAppPermissionLevel,
  GitHubAppPermissions,
  GitHubAppRole,
  GitHubCeiling,
  GitHubSettingsConnection,
  GitHubSettingsInstallation,
} from "@werft-ai/contracts";

const RANK: Record<GitHubAppPermissionLevel, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/** contracts githubPermissionsMissing; apps/web imports only its types. */
export function githubPermissionsMissing(
  granted: GitHubAppPermissions,
  asked: GitHubAppPermissions,
): string[] {
  return Object.entries(asked)
    .filter(([name, level]) => {
      const held = granted[name];
      return held === undefined || RANK[held] < RANK[level];
    })
    .map(([name]) => name)
    .sort();
}

/**
 * The ceiling features the console offers; checks and issues have no work yet.
 * Only the workspace console reads this, so `merge` never reaches an agent's
 * GitHub tab.
 */
export const OFFERED_FEATURES = [
  "actions",
  "workflows",
  "review",
  "merge",
] as const;
export type OfferedFeature = (typeof OFFERED_FEATURES)[number];

/** `base` is writing a PR, always on for an agent with GitHub. */
export type Feature = "base" | OfferedFeature;

/** What each feature's token asks its role's App for (contracts githubPermissionsFor). */
export const FEATURE_NEED: Record<Feature, GitHubAppPermissions> = {
  base: { contents: "write", pull_requests: "write", metadata: "read" },
  actions: { actions: "write" },
  workflows: { workflows: "write" },
  review: { contents: "read", pull_requests: "write" },
  merge: { contents: "write", pull_requests: "read" },
};

export const roleOf = (feature: Feature): GitHubAppRole =>
  feature === "review" ? "reviewer" : "author";

/** The features on under the ceiling, writing a PR always among them. */
export function featuresOn(ceiling: GitHubCeiling): Feature[] {
  return ["base", ...OFFERED_FEATURES.filter((feature) => ceiling[feature])];
}

export type Shortfall = {
  readonly feature: Feature;
  /** Permission names, sorted, at the level FEATURE_NEED gives. */
  readonly missing: readonly string[];
};

/**
 * What the connection's App lacks for the features turned on, one entry a
 * feature. Nothing before the App was read: unread is not short.
 */
export function appShortfalls(
  connection: Pick<GitHubSettingsConnection, "role" | "permissions">,
  ceiling: GitHubCeiling,
): Shortfall[] {
  const held = connection.permissions;
  if (held === null) return [];
  return featuresOn(ceiling)
    .filter((feature) => roleOf(feature) === connection.role)
    .map((feature) => ({
      feature,
      missing: githubPermissionsMissing(held, FEATURE_NEED[feature]),
    }))
    .filter((shortfall) => shortfall.missing.length > 0);
}

/** The permissions those features need, merged at the highest level asked. */
export function neededFor(shortfalls: readonly Shortfall[]) {
  const need: GitHubAppPermissions = {};
  for (const { feature, missing } of shortfalls) {
    for (const name of missing) {
      const level = FEATURE_NEED[feature][name];
      if (level && (need[name] === undefined || need[name] === "read")) {
        need[name] = level;
      }
    }
  }
  return need;
}

/**
 * What the installation has not approved of `asked`, as its own last read
 * says. Empty when that read is not known now: an installation GitHub did
 * not answer for is "unknown", never waiting on an approval.
 */
export function unapproved(
  installation: GitHubSettingsInstallation,
  asked: GitHubAppPermissions | null,
): string[] {
  if (asked === null || installation.status !== "approval_pending") return [];
  const approved = installation.detail?.permissions;
  return approved ? githubPermissionsMissing(approved, asked) : [];
}

export type FeatureMark = "appShort" | "pending" | null;

/**
 * A feature row's one mark: an App of its role lacks what it needs, or an
 * installation of an App that has it has not approved it yet. Approvals of
 * permissions the feature does not use leave it unmarked.
 */
export function featureMark(
  feature: Feature,
  connections: readonly GitHubSettingsConnection[],
  ceiling: GitHubCeiling,
): FeatureMark {
  if (feature !== "base" && !ceiling[feature]) return null;
  const need = FEATURE_NEED[feature];
  const ofRole = connections.filter(
    (connection) => connection.role === roleOf(feature),
  );
  if (
    ofRole.some(
      (connection) =>
        connection.permissions !== null &&
        githubPermissionsMissing(connection.permissions, need).length > 0,
    )
  ) {
    return "appShort";
  }
  return ofRole.some((connection) =>
    connection.installations.some(
      (installation) => unapproved(installation, need).length > 0,
    ),
  )
    ? "pending"
    : null;
}

/** The App's page under its owner, where its permissions are set. */
export function permissionsUrl(
  connection: Pick<GitHubSettingsConnection, "owner" | "html_url">,
): string | null {
  const slug = new URL(connection.html_url).pathname
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (!connection.owner || !slug) return null;
  return connection.owner.type === "organization"
    ? `https://github.com/organizations/${connection.owner.login}/settings/apps/${slug}/permissions`
    : `https://github.com/settings/apps/${slug}/permissions`;
}
