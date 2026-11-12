import type { BootstrapClaimResponse } from "@werft-ai/contracts";
import type { WorkerGatewayClient } from "@werft-ai/runtime-core";

import type { WorkerLogger } from "./console-logger.ts";

/**
 * A value this short is replaced only where it stands alone: the local
 * object store's key is `test`, and replacing it inside every word would
 * wreck the text while a dump of the environment still shows it whole.
 */
const MIN_SUBSTRING_LENGTH = 8;
export const SCRUBBED = "<redacted>";

/** Everything a claim hands this process that the engine's tools could print. */
export function claimSecrets(
  claim: BootstrapClaimResponse,
  bootstrapNonce: string,
): Array<string | undefined> {
  return [
    bootstrapNonce,
    claim.session_credential,
    claim.runtime_config.provider.auth.token,
    claim.workspace.repository?.access?.token,
    ...(claim.workspace.additional_repositories ?? []).map(
      (repository) => repository.access?.token,
    ),
    claim.repository_access?.token,
    claim.object_store.access.token,
    claim.packages?.access.token,
    ...(claim.runtime_config.mcp_servers ?? []).map((s) => s.access.token),
  ];
}

/**
 * Removes the values of the secrets this worker holds from what it sends
 * out. The engine's tools run with the engine's environment, and the launch
 * environment is theirs to read from PID 1, so a Bash call that prints a
 * value hands it to the model, and from there to a tool result or a reply.
 * This process itself is closed to them (process-hardening.ts), but what it
 * hands the engine and git is not. The event stream is what other people
 * read; it gets the text with each known value replaced.
 *
 * By value, not by pattern: the adapter's mapper already catches key-shaped
 * strings, and these tokens are shaped like nothing in particular.
 * Deliberately not attempted: a value the engine re-encodes (base64, split
 * across lines) passes through. The tokens are attempt-scoped and worthless
 * off the worker's network, which is what bounds that.
 */
export class SecretScrubber {
  private readonly secrets: string[];
  private readonly shortSecrets: RegExp | null;

  constructor(values: ReadonlyArray<string | null | undefined>) {
    const known = [
      ...new Set(
        values.filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        ),
      ),
    ];
    // Longest first, so a secret that contains another is replaced whole.
    this.secrets = known
      .filter((value) => value.length >= MIN_SUBSTRING_LENGTH)
      .sort((a, b) => b.length - a.length);
    const short = known.filter((value) => value.length < MIN_SUBSTRING_LENGTH);
    this.shortSecrets =
      short.length === 0
        ? null
        : new RegExp(
            `(?<![A-Za-z0-9])(?:${short.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`,
            "g",
          );
  }

  scrub<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          this.text(key),
          this.walk(item),
        ]),
      );
    }
    return value;
  }

  private text(value: string): string {
    let out = value;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(SCRUBBED);
    }
    if (this.shortSecrets !== null) {
      out = out.replace(this.shortSecrets, SCRUBBED);
    }
    return out;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The gateway as the event stream and the pending requests see it: the two
 * calls that carry what the engine said or asked go out scrubbed.
 */
export function scrubbingGateway(
  gateway: Pick<
    WorkerGatewayClient,
    "appendEvents" | "pendingControl" | "registerPending"
  >,
  scrubber: SecretScrubber,
): Pick<
  WorkerGatewayClient,
  "appendEvents" | "pendingControl" | "registerPending"
> {
  return {
    appendEvents: (request) => gateway.appendEvents(scrubber.scrub(request)),
    pendingControl: (request) => gateway.pendingControl(request),
    registerPending: (request) =>
      gateway.registerPending(scrubber.scrub(request)),
  };
}

/**
 * The log gets the same treatment: an error message can quote what
 * the process holds. `scrubber` is read per line, because the claim that
 * brings most of the secrets arrives after the logger is handed out.
 */
export function scrubbingLogger(
  logger: WorkerLogger,
  scrubber: () => SecretScrubber | undefined,
): WorkerLogger {
  const scrubbed =
    (write: WorkerLogger["info"]) =>
    (event: string, fields?: Record<string, unknown>): void => {
      const current = scrubber();
      write(
        event,
        current === undefined || fields === undefined
          ? fields
          : current.scrub(fields),
      );
    };
  return {
    info: scrubbed((event, fields) => logger.info(event, fields)),
    warn: scrubbed((event, fields) => logger.warn(event, fields)),
    error: scrubbed((event, fields) => logger.error(event, fields)),
  };
}
