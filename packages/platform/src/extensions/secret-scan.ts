/**
 * The secret check of the skill gate (rule 4): what a scanner is given and
 * what it answers. The scanner itself runs outside this package
 * (apps/control-host/src/wiring/gitleaks.ts), because it is a child process.
 */

/** One file of a skill version, by its path inside the skill. */
export type SecretScanFile = {
  /** Relative, `/`-separated, no `.` or `..` segment. */
  readonly path: string;
  readonly bytes: Uint8Array;
};

/** A rule that matched, and where. The matched value is never carried. */
export type SecretFinding = {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
};

/**
 * Why a scan has no answer. None of them is a pass: the version is not
 * judged clean, and the next check runs the scan again.
 */
export type SecretScanFailure =
  /** As many scans as the scanner allows are already running. */
  | "busy"
  /** A path the scanner refuses to write (absolute, `..`, duplicate). */
  | "input_rejected"
  /** The scanner ran past its time limit and was stopped. */
  | "timeout"
  /** The report grew past its size limit and the scanner was stopped. */
  | "output_limit"
  /** The scanner could not start, or exited with an error. */
  | "tool_failed"
  /** The scanner exited cleanly but its report could not be read. */
  | "unreadable_report";

export type SecretScanResult =
  | {
      readonly kind: "scanned";
      readonly findings: readonly SecretFinding[];
    }
  | {
      readonly kind: "failed";
      readonly reason: SecretScanFailure;
      /** For logs: the scanner's exit status or first error line. */
      readonly detail?: string;
    };

/**
 * `scanned` covers every text file given. Binary files are not read:
 * gitleaks tells them by content and skips them, so a caller passes only
 * the binaries the gate lets in (rule 3's media types) and treats what is
 * inside them as unchecked.
 */
export interface SecretScanner {
  scan(files: readonly SecretScanFile[]): Promise<SecretScanResult>;
}
