/**
 * Where the chart's installer writes the Codex sandbox's seccomp profile,
 * under the kubelet's seccomp directory. Fixed: the chart, the installer and
 * this backend agree on it, and no setting moves one without the others.
 * Imports nothing, so the chart's render check can read it without packages.
 */
export const CODEX_SECCOMP_PROFILE = "werft/codex-sandbox.json";
