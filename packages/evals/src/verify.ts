export type VerificationReport = { schema: boolean; authenticated: boolean; replayPasses: number; noSecretLeakage: boolean; browserExecution: boolean; selectionScore: number };
export function evaluateRelease(report: VerificationReport) {
  const failures = [!report.schema && "SCHEMA", !report.authenticated && "AUTH", report.replayPasses < 3 && "REPLAY", !report.noSecretLeakage && "SECRET_LEAKAGE", !report.browserExecution && "BROWSER", report.selectionScore < 18 && "TOOL_SELECTION"].filter(Boolean) as string[];
  return { eligible: failures.length === 0, failures };
}
