import type { Server } from "node:net";

/** Binds a test peer to an ephemeral loopback port and returns its base URL. */
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test peer did not bind a port");
  }
  return `http://127.0.0.1:${address.port}`;
}
