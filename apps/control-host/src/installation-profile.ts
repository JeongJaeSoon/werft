/**
 * What kind of installation this is: `INSTALLATION_PROFILE` is `production`
 * (default) or `test`. A setting that trades a production guarantee for an
 * easier trial is accepted only on `test`, and says so where it is read.
 */
export type InstallationProfile = "production" | "test";

export function installationProfileFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
): InstallationProfile {
  const value = environment.INSTALLATION_PROFILE?.trim();
  if (value === undefined || value === "" || value === "production") {
    return "production";
  }
  if (value === "test") return "test";
  throw new Error(
    `INSTALLATION_PROFILE must be "production" (default) or "test", not ${value}`,
  );
}
