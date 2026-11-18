import { describe, expect, test } from "bun:test";
import {
  DockerApiError,
  DockerClient,
  DockerTimeoutError,
  isTransientPullFailure,
  PULL_ATTEMPTS,
  parseDockerHost,
  parseImageReference,
} from "./docker-client.ts";

describe("parseImageReference", () => {
  test("keeps registry ports in the name and reads tags or digests", () => {
    expect(parseImageReference("busybox:1.36")).toEqual({
      name: "busybox",
      tag: "1.36",
    });
    expect(parseImageReference("busybox")).toEqual({
      name: "busybox",
      tag: "latest",
    });
    expect(parseImageReference("localhost:5000/org/worker:tag")).toEqual({
      name: "localhost:5000/org/worker",
      tag: "tag",
    });
    expect(parseImageReference("localhost:5000/org/worker")).toEqual({
      name: "localhost:5000/org/worker",
      tag: "latest",
    });
    expect(parseImageReference("ghcr.io/org/worker@sha256:abc")).toEqual({
      name: "ghcr.io/org/worker",
      tag: "sha256:abc",
    });
  });
});

describe("parseDockerHost", () => {
  test("accepts the DOCKER_HOST spellings", () => {
    expect(parseDockerHost("unix:///var/run/docker.sock")).toEqual({
      kind: "unix",
      socketPath: "/var/run/docker.sock",
    });
    expect(parseDockerHost("tcp://127.0.0.1:2375")).toEqual({
      baseUrl: "http://127.0.0.1:2375",
      kind: "http",
    });
    expect(parseDockerHost("https://docker.internal:2376")).toEqual({
      baseUrl: "https://docker.internal:2376",
      kind: "http",
    });
  });

  test("rejects unknown schemes and an empty socket path", () => {
    expect(() => parseDockerHost("unix://")).toThrow("socket path");
    expect(() => parseDockerHost("/var/run/docker.sock")).toThrow("unix://");
  });
});

describe("DockerClient deadlines", () => {
  test("waits out the stop grace, and only the stop", async () => {
    // A daemon that takes longer than the request deadline to answer, the
    // way a stop does while the container drains.
    const daemon = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/stop") || path.endsWith("/version")) {
          await Bun.sleep(150);
        }
        return new Response(null, { status: 204 });
      },
    });
    try {
      const client = new DockerClient(
        `tcp://127.0.0.1:${daemon.port}`,
        "v1.43",
        { timeoutMs: 50 },
      );

      await expect(
        client.stopAndRemoveContainer("worker-1", 1),
      ).resolves.toBeUndefined();
      await expect(client.version()).rejects.toBeInstanceOf(DockerTimeoutError);
    } finally {
      daemon.stop(true);
    }
  });
});

describe("DockerClient.pullImage", () => {
  // Each pull answers with the next of `answers`; the last one repeats. The
  // deadline is far past any answer, so no count here depends on the clock;
  // which failures count as a stall is checked on its own below.
  async function pulls(
    answers: ("ok" | number)[],
    run: (client: DockerClient) => Promise<void>,
  ): Promise<number> {
    let count = 0;
    const daemon = Bun.serve({
      port: 0,
      fetch() {
        const answer = answers[Math.min(count, answers.length - 1)] ?? "ok";
        count += 1;
        return new Response(answer === "ok" ? '{"status":"done"}' : "{}", {
          status: answer === "ok" ? 200 : answer,
        });
      },
    });
    try {
      await run(
        new DockerClient(`tcp://127.0.0.1:${daemon.port}`, "v1.43", {
          timeoutMs: 60_000,
        }),
      );
    } finally {
      daemon.stop(true);
    }
    return count;
  }

  test("asks again after registry errors, and ends once pulled", async () => {
    expect(
      await pulls([500, 502, "ok"], (client) =>
        client.pullImage("ghcr.io/org/bun@sha256:abc"),
      ),
    ).toBe(3);
  });

  test("takes a deadline that passed, before the answer or while it drained, for a stall", () => {
    const drained = new DOMException(
      "The operation timed out.",
      "TimeoutError",
    );
    expect(
      isTransientPullFailure(
        new DockerTimeoutError("POST", "/images/create", 1),
      ),
    ).toBe(true);
    expect(isTransientPullFailure(drained)).toBe(true);
    expect(
      isTransientPullFailure(new DockerApiError(500, "POST", "/", "")),
    ).toBe(true);
    expect(
      isTransientPullFailure(new DockerApiError(404, "POST", "/", "")),
    ).toBe(false);
    expect(isTransientPullFailure(new TypeError("fetch failed"))).toBe(false);
  });

  test(`gives up after ${PULL_ATTEMPTS} failed pulls with the last error`, async () => {
    expect(
      await pulls([503], async (client) => {
        await expect(client.pullImage("busybox")).rejects.toMatchObject({
          name: "DockerApiError",
          status: 503,
        });
      }),
    ).toBe(PULL_ATTEMPTS);
  });

  test("does not ask again for an image the registry does not have", async () => {
    expect(
      await pulls([404], async (client) => {
        await expect(client.pullImage("busybox")).rejects.toBeInstanceOf(
          DockerApiError,
        );
      }),
    ).toBe(1);
  });
});
