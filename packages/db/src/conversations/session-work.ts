import { type AdmissionState, admissionStateSchema } from "@werft-ai/contracts";

/**
 * The admissions a session's work is closed in (decision 35): closing or
 * closed. Any other is work still open, an idle, paused or stopped session
 * included: a reply to its thread is the work's to take.
 */
export const CLOSED_WORK_ADMISSION_STATES = [
  "closing",
  "closed",
] as const satisfies readonly AdmissionState[];

/**
 * Whether a session's work is closed (decision 35), by the admission_state
 * a sessions row holds; parsed here, so a value outside the enum throws.
 * No session left is closed work: nothing is there to take a reply.
 */
export function sessionWorkClosed(admissionState: string | undefined): boolean {
  if (admissionState === undefined) return true;
  return (CLOSED_WORK_ADMISSION_STATES as readonly AdmissionState[]).includes(
    admissionStateSchema.parse(admissionState),
  );
}
