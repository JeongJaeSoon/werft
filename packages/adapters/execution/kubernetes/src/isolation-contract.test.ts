import { expect, test } from "bun:test";
import { ISOLATION_CONTRACT } from "./specs.ts";

/**
 * What each isolation contract asks of the worker image. A session resumes
 * on the image it recorded, which can predate this control host, so a
 * contract that needs the image's cooperation does not hold on an older
 * image `WORKER_IMAGES` still lists. A bump that needs it has to say how
 * those images are kept off it (rebuilt, retracted, or refused at launch).
 */
const WORKER_IMAGE_COOPERATION: Record<
  number,
  { needsImage: boolean; why: string }
> = {
  1: {
    needsImage: true,
    why: "image baseline, as local-docker's contracts 1-3: runs as a non-root uid and writes only to the workspace PVC and the emptyDir /tmp and HOME, reaches the network only through HTTP(S)_PROXY, keeps object keys under WORKER_OBJECT_PREFIX; the nonce arrives in the same env variable, from a Secret",
  },
  2: {
    needsImage: false,
    why: "the proxy's name resolves through the Pod's /etc/hosts (hostAliases) instead of cluster DNS; the image resolves names as before",
  },
};

test("every isolation contract records what it asks of the worker image", () => {
  expect(Object.keys(WORKER_IMAGE_COOPERATION).map(Number)).toEqual(
    Array.from({ length: ISOLATION_CONTRACT }, (_, index) => index + 1),
  );
});
