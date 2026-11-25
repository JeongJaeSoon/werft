/**
 * Test scaffolding for the steps no public HTTP call causes: a lost volume,
 * a stopped database. Never a way to read or change what a session did.
 */
export async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, stdout, stderr };
}
