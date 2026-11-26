import { z } from "zod";

/** Money is stored as numeric and travels as a decimal string, never a float. */
export const costUsdSchema = z.string().regex(/^\d+(\.\d+)?$/);
