import { acmeCapabilityEvidence, acmeCapabilityPlans } from "../../acme-support/src/capability-plans.ts";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import type { AnalysisAdapter } from "./workflow.ts";

/** Explicitly local-only adapter used by `pnpm dev` and never by production. */
export function createLocalFixtureAnalysisAdapter(): AnalysisAdapter {
  return async (source) => {
    const targetOrigin = source.sourceType === "github"
      ? "https://acme.example"
      : source.sourceConfiguration?.kind === "openapi"
        ? source.sourceConfiguration.targetOrigin
        : new URL(source.sourceUrl).origin;
    const plans = acmeCapabilityPlans(targetOrigin).slice(0, source.sourceType === "github" ? 1 : 3);
    const release = compileWebMcpRelease(plans);
    return {
      capabilities: plans.map((plan) => ({ plan, status: "proposed" as const })),
      diagnostics: [],
      evidence: acmeCapabilityEvidence().filter(({ reference }) =>
        plans.some((plan) => plan.evidence.some((item) => item.reference === reference))),
      release,
      providerProvenance: { mode: "local", adapter: "local-fixture", adapterVersion: 1, fixture: true },
    };
  };
}
