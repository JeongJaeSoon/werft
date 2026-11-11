import { sql } from "drizzle-orm";

export type Raw = Record<string, unknown>;

export const ms = (value: number) =>
  sql`make_interval(secs => ${value / 1000})`;

export const released = { claimToken: null, leaseExpiresAt: null } as const;
