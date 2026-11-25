/** The environment variable an image build writes the Werft version to. */
export const WERFT_VERSION_VARIABLE = "WERFT_VERSION";

/** What a build that wrote no version (a local checkout) answers as. */
export const WERFT_VERSION_UNKNOWN = "0.0.0-unknown";

/**
 * The Werft version this process was built as: a release tag, or a commit
 * for a build between releases. The built-in `werft` server answers as it,
 * and its parts name the same one.
 */
export function werftVersionOf(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const version = env[WERFT_VERSION_VARIABLE]?.trim();
  return version === undefined || version === ""
    ? WERFT_VERSION_UNKNOWN
    : version;
}
