import {
  createPostgresExtensionBundleStore,
  type Database,
} from "@werft-ai/db";
import type { SessionExtensionsDeps } from "@werft-ai/platform";
import { installedRuntimes } from "./catalog-config.ts";

/**
 * What resolves a session's bundles and checks an agent's bundles against the
 * profile a release activates it on. Every service that creates sessions or
 * activates releases takes it, the operator CLIs included: a path without it
 * would activate what the API refuses.
 */
export function extensionDepsFor(db: Database): SessionExtensionsDeps {
  return {
    store: createPostgresExtensionBundleStore(db),
    offersSkills: (kind) => installedRuntimes.offers(kind, "skills"),
  };
}
