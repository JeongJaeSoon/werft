import { expect, test } from "bun:test";
import {
  INSTALLATION_CONFIG,
  INSTALLATION_CONFIG_KEYS,
  type InstallationConfigKey,
  installationConfigEnvOf,
} from "./installation-config.ts";

const past = Number.MAX_SAFE_INTEGER + 1;

// The ranges the env parsers held before these moved to the console.
const rejected: Record<InstallationConfigKey, unknown[]> = {
  pending_request_ttl_sec: [0, 1.5, 7 * 24 * 60 * 60 + 1, "1800"],
  queued_input_limit_per_session: [0, 1.5, 100_001],
  storage_limit_bytes: [0, 1.5, past],
  session_cost_limit_usd: [0, -5, Number.POSITIVE_INFINITY, "abc", 1_000_001],
  session_token_limit: [-1, 1.5, "lots", past],
  // 0 would switch the limit off, which this one does not allow.
  unknown_price_session_token_limit: [0, -1, 1.5, "lots", past],
  workspace_enforce: ["strict", ""],
  max_turn_seconds: [0, 1.5, 7 * 24 * 60 * 60 + 1, "3600"],
  provider_max_retries: [-1, 1.5, 11, "2"],
  session_archive_after_days: [1, 29, 45.5, 3651, -30, "180"],
  session_archive_dry_run: ["true", 1, 0, null],
  workspace_stopped_ttl_sec: [-1, 1.5, 315_360_001, "86400"],
  workspace_paused_ttl_sec: [-1, 1.5, 315_360_001, "86400"],
  judgment_buffer_limit_per_channel: [0, 1.5, 100_001, "100"],
};

const accepted: Record<InstallationConfigKey, unknown[]> = {
  pending_request_ttl_sec: [1, 7 * 24 * 60 * 60],
  queued_input_limit_per_session: [1, 100_000],
  storage_limit_bytes: [1, Number.MAX_SAFE_INTEGER],
  session_cost_limit_usd: [0.5, 1_000_000],
  session_token_limit: [0, 500_000],
  unknown_price_session_token_limit: [1, 5_000_000, Number.MAX_SAFE_INTEGER],
  workspace_enforce: ["warn", "fail", "off"],
  max_turn_seconds: [1, 7 * 24 * 60 * 60],
  provider_max_retries: [0, 10],
  session_archive_after_days: [0, 30, 3650],
  session_archive_dry_run: [true, false],
  workspace_stopped_ttl_sec: [0, 86_400, 315_360_000],
  workspace_paused_ttl_sec: [0, 86_400, 315_360_000],
  judgment_buffer_limit_per_channel: [1, 100, 100_000],
};

test("each key holds the range its env variable held", () => {
  for (const key of INSTALLATION_CONFIG_KEYS) {
    const { schema } = INSTALLATION_CONFIG[key];
    for (const value of rejected[key]) {
      expect(schema.safeParse(value).success, `${key}=${value}`).toBe(false);
    }
    for (const value of accepted[key]) {
      expect(schema.safeParse(value).success, `${key}=${value}`).toBe(true);
    }
  }
});

test("each default is one its own rule accepts", () => {
  for (const key of INSTALLATION_CONFIG_KEYS) {
    const { schema, default: fallback } = INSTALLATION_CONFIG[key];
    expect(schema.safeParse(fallback).success, key).toBe(true);
  }
});

test("a carried-in value that failed is a row no rule accepts", () => {
  for (const key of INSTALLATION_CONFIG_KEYS) {
    const { schema } = INSTALLATION_CONFIG[key];
    const env = installationConfigEnvOf(key) ?? key;
    expect(schema.safeParse({ refused_env: env }).success, key).toBe(false);
  }
});
