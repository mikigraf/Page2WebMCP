export type Evidence = { source: "runtime" | "openapi" | "source"; authentication: string; effects: string };
export function mergeEvidence(evidence: Evidence[]) {
  const authentication = new Set(evidence.map((item) => item.authentication));
  const effects = new Set(evidence.map((item) => item.effects));
  return authentication.size === 1 && effects.size === 1 ? { status: "consistent" as const, evidence } : { status: "conflict" as const, evidence, conflicts: [authentication.size > 1 && "AUTHENTICATION", effects.size > 1 && "EFFECTS"].filter(Boolean) };
}
