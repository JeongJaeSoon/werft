import { describe, expect, test } from "bun:test";
import { SessionServiceError } from "@werft-ai/platform";

import { ApiHttpError } from "../app.ts";
import { mapped } from "./errors.ts";

describe("the variable errors a session start can answer", () => {
  test("a name that has no value is 409 VARIABLE_UNRESOLVED, and the details pass through as they are", async () => {
    const details = {
      reason_code: "variable_unresolved",
      agent_id: "019a0000-0000-7000-8000-00000000b0a1",
      receipt_id: "019a0000-0000-7000-8000-00000000c0a1",
      admins: [],
      admin_link: null,
    };
    const error = await mapped(async () => {
      throw new SessionServiceError(
        "VARIABLE_UNRESOLVED",
        "A variable this agent's card declares has no value for it; ask the agent's administrator",
        undefined,
        details,
      );
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error).toMatchObject({
      status: 409,
      code: "VARIABLE_UNRESOLVED",
      details,
    });
  });

  test("a card that declares a name the platform sets itself is 400 VARIABLE_NAME_RESERVED", async () => {
    const error = await mapped(async () => {
      throw new SessionServiceError(
        "VARIABLE_NAME_RESERVED",
        "The card declares PATH, a name the platform sets itself",
      );
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 400,
      code: "VARIABLE_NAME_RESERVED",
    });
  });
});
