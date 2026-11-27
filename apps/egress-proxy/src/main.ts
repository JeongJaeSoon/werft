import { egressProxyConfigFromEnv } from "./config.ts";
import { startCredentialProxy } from "./credential.ts";
import { createDenialReporter } from "./denial-report.ts";
import { createProxyLogger } from "./logger.ts";
import { type EgressProxyServer, startEgressProxy } from "./proxy.ts";
import { sourceDigest } from "./source.ts";

/**
 * The only container on the worker network with a route off it. Workers
 * reach it through `HTTP_PROXY`/`HTTPS_PROXY`; everything it will not
 * forward is unreachable from a worker, because nothing else is. The
 * credential routes, when configured, are where a worker's provider and
 * repository calls pick up the credentials it never holds.
 */
export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<EgressProxyServer> {
  const config = egressProxyConfigFromEnv(environment);
  const logger = createProxyLogger(config.logLevel);
  const policy = { allow: config.allow, allowPrivate: config.allowPrivate };
  const forward = await startEgressProxy({
    hostname: config.hostname,
    logger,
    policy,
    port: config.port,
    // Through the authorizer the credential routes ask: without one, a
    // refusal is answered and reported to nobody.
    ...(config.credential === null
      ? {}
      : {
          reportDenial: createDenialReporter({
            authorizerUrl: config.credential.authorizerUrl,
            token: config.credential.authorizerToken,
            logger,
          }),
        }),
    sourceDigest: sourceDigest(import.meta.dir),
  });
  if (config.credential === null) {
    logger.warn(
      "Credential routes are off (EGRESS_AUTHORIZER_URL unset); workers cannot reach their provider or repository",
      {},
    );
    return forward;
  }
  const credential = startCredentialProxy({
    authorizer: {
      url: config.credential.authorizerUrl,
      token: config.credential.authorizerToken,
    },
    hostname: config.hostname,
    logger,
    // The forward allowlists plus what only these routes may reach. The
    // upstream is always the authorizer's to name, never the worker's.
    policy: {
      allow: [...config.allow, ...config.credential.allow],
      allowPrivate: [...config.allowPrivate, ...config.credential.allowPrivate],
    },
    // Public only: a registry's redirect is never a way into the private plane.
    packagesRedirect: {
      allow: config.credential.packagesRedirect,
      allowPrivate: [],
    },
    port: config.credential.port,
  });
  return {
    port: forward.port,
    stop(): void {
      credential.stop();
      forward.stop();
    },
  };
}

if (import.meta.main) {
  const server = await main();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.stop();
      process.exit(0);
    });
  }
}
