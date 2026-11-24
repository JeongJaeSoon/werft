import type { PermitRelay } from "../conversation/permit-relay.ts";

/** A relay that listens nowhere and keeps each session key's permit. */
export function fakePermitRelay(): Pick<
  PermitRelay,
  "url" | "open" | "close" | "hold" | "release"
> & { permits: Map<string, string | null>; held: string[] } {
  const permits = new Map<string, string | null>();
  const held: string[] = [];
  let next = 0;
  return {
    url: "http://127.0.0.1:1",
    permits,
    held,
    open: () => {
      const key = `session-${++next}`;
      permits.set(key, null);
      return key;
    },
    close: (key) => void permits.delete(key),
    hold: (key, permit) => {
      if (!permits.has(key)) throw new Error("No such session key");
      permits.set(key, permit);
      held.push(permit);
    },
    release: (key) => {
      if (permits.has(key)) permits.set(key, null);
    },
  };
}
