import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type {
  AwsCredentialIdentity,
  AwsCredentialIdentityProvider,
} from "@smithy/types";
import {
  FreshAddressHttpHandler,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_BOUNDS,
  type S3RequestBounds,
} from "./s3.ts";

export {
  bucketHoldsObjectVersion,
  createCheckpointObjectCollector,
  createCheckpointObjectStore,
  describeBucketEncryption,
  describeBucketProtection,
} from "./checkpoint-objects.ts";
export { rangeAttribution } from "./commit-range-attribution.ts";
export {
  defaultGitRunner,
  GIT_TIMEOUT_EXIT_CODE,
  type GitCommandOptions,
  type GitCommandRunner,
  type GitResourceLimits,
} from "./git-runner.ts";
export {
  createGitWorkspaceBundleVerifier,
  DEFAULT_GIT_VERIFY_TIMEOUT_MS,
  DEFAULT_MAX_GIT_MEMORY_BYTES,
  gitRefNameAcceptable,
  gitVerifyTimeoutMs,
} from "./git-workspace-bundle-verifier.ts";
export {
  createObjectRouteClient,
  createObjectRouteSigner,
  type ObjectRouteSigner,
} from "./object-route.ts";
export {
  BodyLimitError,
  type BodyReadBounds,
  BodyStallError,
  BodyTruncatedError,
  FreshAddressHttpHandler,
  S3_REQUEST_BOUNDS,
  type S3ClientLike,
  type S3RequestBounds,
  transferBudgetMs,
} from "./s3.ts";
export { scopedCheckpointObjectStore } from "./scoped-objects.ts";

export interface StorageS3Settings {
  readonly credentials?: StorageS3StaticKeys;
  readonly endpoint?: string;
  readonly region: string;
}

export interface StorageS3StaticKeys {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The static keys when given, else the SDK's default credential chain:
 * environment, shared config, web identity (IRSA on EKS), container and
 * instance metadata. Never anonymous: a chain that finds nothing fails the
 * request instead of sending it unsigned. The chain caches what it resolved
 * and fetches again near expiry, so one provider can sign for the life of
 * the process.
 */
export function storageS3Credentials(
  settings: StorageS3Settings,
): AwsCredentialIdentity | AwsCredentialIdentityProvider {
  return settings.credentials ?? defaultProvider();
}

/**
 * The one place this package builds an S3 client, so the bounds it runs under
 * are the ones in {@link S3_REQUEST_BOUNDS}. `bounds` exists for tests that
 * cannot wait out the shipped values.
 */
export function createStorageS3Client(
  config: { readonly s3: StorageS3Settings },
  bounds: S3RequestBounds = S3_REQUEST_BOUNDS,
): S3Client {
  const s3Config: S3ClientConfig = {
    credentials: storageS3Credentials(config.s3),
    maxAttempts: S3_MAX_ATTEMPTS,
    region: config.s3.region,
    requestHandler: new FreshAddressHttpHandler(bounds),
    ...(config.s3.endpoint === undefined
      ? {}
      : { endpoint: config.s3.endpoint, forcePathStyle: true }),
  };
  return new S3Client(s3Config);
}
