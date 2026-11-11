export function queueDatabaseUrl(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const databaseUrl =
    environment.DATABASE_URL || environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  return databaseUrl;
}
