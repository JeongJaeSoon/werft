import {
  type Database,
  listStrandedSessions,
  reconcileSessionPins,
  releaseSpecStore,
  sessionPinGate,
} from "@werft-ai/db";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  acceptedRuntimeVersions,
  backfillReleaseSpecs,
  type CatalogProfile,
  type CatalogProfileView,
  catalogProfile,
  connectionMatcher,
  type ProfileLookup,
} from "@werft-ai/platform";

// While anything is still unresolved the run repeats soon; once the gate is
// open it only watches for an old replica writing a stale pin.
const BUSY_MS = 60_000;
const WATCH_MS = 10 * 60_000;
const RETRY_MS = 30_000;

type Settings = Parameters<typeof connectionMatcher>[0];

/**
 * One pass: give every release without a spec one, then bring the spec pin of
 * every live session in line with its release, then read the gate. Releases
 * are resolved against the catalog and connections as loaded now, so the first
 * pass must follow the first catalog load; a release whose profile is not
 * there is listed and tried again on the next pass, never guessed.
 */
export async function reconcileSpecs(deps: {
  db: Database;
  catalog: ProfileLookup<CatalogProfileView> & {
    runtime_versions?: Parameters<
      typeof acceptedRuntimeVersions
    >[0]["runtime_versions"];
  };
  settings: () => Settings;
}) {
  const matcher = connectionMatcher(deps.settings());
  const accepted = acceptedRuntimeVersions(deps.catalog);
  const releases = await backfillReleaseSpecs(
    releaseSpecStore(deps.db),
    (release) => {
      const profile = catalogProfile(deps.catalog, release.runtime_profile_id);
      if (profile === undefined) return null;
      // A workspace version has no provider of its own: it follows its base.
      const installationId =
        deps.catalog.workspace_profiles?.records.get(release.runtime_profile_id)
          ?.base_profile_id ?? release.runtime_profile_id;
      // The connection is matched on the stored definition. The loaded
      // profile's provider carries the resolved credential, so it never
      // equals a connection's.
      const provider =
        deps.catalog.installation?.get(installationId)?.definition?.provider;
      return {
        // The view only lacks the provider's credential, which no spec reads.
        profile: profile as unknown as CatalogProfile,
        connectionId:
          provider === undefined ? null : matcher.connectionOf(provider),
        acceptedVersions: accepted,
      };
    },
  );
  const pins = await reconcileSessionPins(deps.db);
  const gate = await sessionPinGate(deps.db);
  // They hold the gate closed until they end; the owner decides which to stop.
  const stranded =
    gate.releaseLess === 0 ? [] : await listStrandedSessions(deps.db, 50);
  return { releases, pins, gate, stranded };
}

export function startSpecReconciliation(
  deps: Parameters<typeof reconcileSpecs>[0],
  logger: Pick<StructuredLogger, "info" | "warn">,
): void {
  const pass = (): void => {
    reconcileSpecs(deps).then(
      ({ releases, pins, gate, stranded }) => {
        logger.info("Release specs and session pins reconciled", {
          releases_stored: releases.stored,
          releases_raced: releases.raced,
          releases_skipped: releases.skipped.length,
          skipped_reasons: [...new Set(releases.skipped.map((s) => s.reason))],
          pins_repaired: pins.repaired,
          pins_raced: pins.raced,
          pins_unresolved: pins.unresolved,
          pins_model_unknown: pins.modelUnknown,
          gate_open: gate.open,
          gate_missing: gate.missing,
          gate_mismatched: gate.mismatched,
          gate_unverifiable: gate.unverifiable,
          gate_model_unknown: gate.modelUnknown,
          gate_release_less: gate.releaseLess,
          // First 50 by id: what the owner lists and decides on.
          stranded_sessions: stranded.map((s) => ({
            id: s.id,
            status: s.status,
            queued_inputs: s.queuedInputs,
            last_checkpoint: s.lastCheckpoint,
          })),
        });
        const settled =
          gate.open && releases.skipped.length === 0 && pins.unresolved === 0;
        setTimeout(pass, settled ? WATCH_MS : BUSY_MS).unref();
      },
      (error: unknown) => {
        logger.warn("Release specs could not be reconciled; retrying", {
          error_name: error instanceof Error ? error.name : typeof error,
        });
        setTimeout(pass, RETRY_MS).unref();
      },
    );
  };
  pass();
}
