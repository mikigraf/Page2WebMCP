import type { AnalysisDiagnostic, AnalysisResult } from "../../../packages/database/src/control-plane.ts";

const MAX_PRESENTED_DIAGNOSTICS = 32;

export type AnalysisOutcome = Readonly<{
  status: "pending" | "supported" | "unsupported";
  capabilityCount: number;
  diagnostics: readonly AnalysisDiagnostic[];
  diagnosticsTruncated?: true;
}>;

/** A bounded, code-free analysis result suitable for project and polling UIs. */
export function analysisOutcome(
  result: AnalysisResult | undefined,
  capabilityCount: number,
): AnalysisOutcome {
  if (!result) return { status: "pending", capabilityCount: 0, diagnostics: [] };
  const diagnostics = result.diagnostics.slice(0, MAX_PRESENTED_DIAGNOSTICS)
    .map(({ code, operationKey, reason }) => ({ code, operationKey, ...(reason ? { reason } : {}) }));
  return {
    status: result.release && capabilityCount > 0 ? "supported" : "unsupported",
    capabilityCount,
    diagnostics,
    ...(result.diagnostics.length > diagnostics.length ? { diagnosticsTruncated: true as const } : {}),
  };
}
