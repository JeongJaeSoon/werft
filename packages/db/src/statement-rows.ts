export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result !== null &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error("Database statement returned no rows");
}
