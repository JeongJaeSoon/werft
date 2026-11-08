import { randomBytes } from "node:crypto";
import {
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/**
 * Hands a minted BOOTSTRAP_TOKEN to the operator without the container log.
 * The API writes it here (owner-only) and `bootstrap-token` takes it out: the
 * file is the only copy outside the process, and taking it deletes it.
 */
export function writeBootstrapTokenFile(path: string, token: string): void {
  rmSync(path, { force: true });
  // "wx" so a file planted between the rm and the write is an error, not a
  // token written into someone else's file.
  writeFileSync(path, token, { flag: "wx", mode: 0o600 });
}

export function removeBootstrapTokenFile(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Returns the pending token and deletes the file, or null when there is none.
 * The rename is what makes two concurrent callers safe: only one of them
 * moves the file, so only one of them sees the value.
 */
export function takeBootstrapTokenFile(path: string): string | null {
  const taken = `${path}.taken-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, taken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return readFileSync(taken, "utf8");
  } finally {
    unlinkSync(taken);
  }
}

if (import.meta.main) {
  const path = process.env.BOOTSTRAP_TOKEN_FILE;
  if (!path) {
    console.error("BOOTSTRAP_TOKEN_FILE is not set for this API");
    process.exit(2);
  }
  const token = takeBootstrapTokenFile(path);
  if (token === null) {
    console.error(
      "No pending bootstrap token: it was already shown, a first owner exists, or BOOTSTRAP_TOKEN is set in the env file. " +
        "Before the first owner exists, restart the API to mint a new one.",
    );
    process.exit(1);
  }
  process.stdout.write(`${token}\n`);
}
