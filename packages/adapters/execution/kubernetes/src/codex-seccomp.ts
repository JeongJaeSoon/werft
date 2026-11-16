/**
 * Where the chart's installer writes the Codex sandbox's seccomp profile,
 * under the kubelet's seccomp directory. Fixed: the chart, the installer and
 * this backend agree on it, and no setting moves one without the others.
 * Imports nothing, so the chart's render check can read it without packages.
 */
export const CODEX_SECCOMP_PROFILE = "werft/codex-sandbox.json";

/**
 * The node label the installer sets once it has written the profile, and
 * that a Pod given the profile requires. The installer never removes it: the
 * file stays on the node when the installer's Pod goes, so the label does too.
 */
export const CODEX_SECCOMP_NODE_LABEL = {
  key: "werft.codex-seccomp-profile",
  value: "installed",
} as const;
