import { expect, test } from "bun:test";
import { ISOLATION_CONTRACT } from "./backend.ts";

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
    why: "image baseline: runs as uid/gid 1000 and writes only to /workspace (owned by 1000 in the image) and the tmpfs /tmp and HOME; apps/worker/Dockerfile asserts both",
  },
  2: {
    needsImage: true,
    why: "image baseline: the worker and the tools it runs reach the network only through HTTP(S)_PROXY from the environment; the internal network has no other route",
  },
  3: {
    needsImage: true,
    why: "the worker reads WORKER_OBJECT_PREFIX and keeps its object keys under it (apps/worker/src/object-store.ts, shipped with this contract in #65)",
  },
  4: {
    needsImage: false,
    why: "the backend creates the workspace volume under a byte quota; the image only sees /workspace",
  },
  5: {
    needsImage: false,
    why: "the backend gives each worker an internal network of its own; the route to the proxy is unchanged",
  },
  6: {
    needsImage: false,
    why: "the backend creates that network with no host address on it; the image never addressed the host",
  },
  7: {
    needsImage: false,
    why: "the backend sets an inode ceiling on the workspace volume; the image only sees /workspace",
  },
};

test("every isolation contract records what it asks of the worker image", () => {
  expect(Object.keys(WORKER_IMAGE_COOPERATION).map(Number)).toEqual(
    Array.from({ length: ISOLATION_CONTRACT }, (_, index) => index + 1),
  );
});
