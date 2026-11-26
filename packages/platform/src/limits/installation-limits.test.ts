import { describe, expect, test } from "bun:test";
import {
  budgetExceeded,
  InstallationConfigError,
  installationLimitProblems,
  installationLimitsFromEnv,
} from "./installation-limits.ts";

const complete = { EXECUTION_SLOT_LIMIT: "10" };

describe("installationLimitsFromEnv", () => {
  test("reads every limit", () => {
    expect(installationLimitsFromEnv(complete)).toEqual({
      executionSlotLimit: 10,
    });
  });

  test("names every missing limit at once and has no defaults for them", () => {
    let thrown: unknown;
    try {
      installationLimitsFromEnv({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InstallationConfigError);
    expect((thrown as InstallationConfigError).problems).toEqual([
      "EXECUTION_SLOT_LIMIT is required",
    ]);
  });

  test("rejects values outside each limit's range", () => {
    const rejected: Record<string, string[]> = {
      EXECUTION_SLOT_LIMIT: ["-1", "1.5", "10001", "ten"],
    };
    for (const [name, values] of Object.entries(rejected)) {
      for (const value of values) {
        const problems = installationLimitProblems({
          ...complete,
          [name]: value,
        });
        expect(problems, `${name}=${value}`).toHaveLength(1);
        expect(problems[0], `${name}=${value}`).toStartWith(name);
      }
    }
  });

  test("accepts a zero slot limit", () => {
    expect(
      installationLimitsFromEnv({ ...complete, EXECUTION_SLOT_LIMIT: "0" }),
    ).toMatchObject({ executionSlotLimit: 0 });
  });
});

test("the budget is spent once the cost reaches the limit", () => {
  const budget = { costUsd: 25, tokens: null };
  const spend = (costUsd: number) => ({ costUsd, providerTokens: 10 ** 12 });
  expect(budgetExceeded(spend(24.999999), budget)).toBe(false);
  expect(budgetExceeded(spend(25), budget)).toBe(true);
  expect(budgetExceeded(spend(30), budget)).toBe(true);
});

test("the budget is spent once the tokens reach the limit, whatever they cost", () => {
  const budget = { costUsd: 25, tokens: 1000 };
  const spend = (providerTokens: number) => ({ costUsd: 0, providerTokens });
  expect(budgetExceeded(spend(999), budget)).toBe(false);
  expect(budgetExceeded(spend(1000), budget)).toBe(true);
  expect(budgetExceeded({ costUsd: 25, providerTokens: 0 }, budget)).toBe(true);
});
