import { z } from "zod";

export type RiskTier = "R0" | "R1" | "R2" | "R3";
export type CapabilityStatus = "discovered" | "proposed" | "reviewed" | "verified" | "production_ready" | "blocked";
export type CapabilityEvent = "review_approved" | "verification_passed" | "publish_requested";

export type Capability = {
  identity: { name: string };
  safety: { riskTier: RiskTier; readOnly: boolean; confirmation: "none" | "first_in_session" | "always" | "blocked" };
  verification: { schema: boolean; authenticated: boolean; replayPasses: number; noSecretLeakage: boolean; browserExecution: boolean; selectionScore: number };
  status: CapabilityStatus;
};

export const CapabilityIRSchema = z.object({
  identity: z.object({ name: z.string().min(1) }).strict(),
  safety: z.object({
    riskTier: z.enum(["R0", "R1", "R2", "R3"]),
    readOnly: z.boolean(),
    confirmation: z.enum(["none", "first_in_session", "always", "blocked"])
  }).strict(),
  verification: z.object({
    schema: z.boolean(),
    authenticated: z.boolean(),
    replayPasses: z.number().int().min(0),
    noSecretLeakage: z.boolean(),
    browserExecution: z.boolean(),
    selectionScore: z.number().min(0).max(20)
  }).strict(),
  status: z.enum(["discovered", "proposed", "reviewed", "verified", "production_ready", "blocked"])
}).strict();

export function createCapability(name: string, riskTier: RiskTier, readOnly: boolean): Capability {
  return CapabilityIRSchema.parse({
    identity: { name },
    safety: { riskTier, readOnly, confirmation: riskTier === "R3" ? "blocked" : riskTier === "R1" ? "first_in_session" : "none" },
    verification: { schema: false, authenticated: false, replayPasses: 0, noSecretLeakage: false, browserExecution: false, selectionScore: 0 },
    status: riskTier === "R3" ? "blocked" : "proposed"
  });
}

function verified(capability: Capability): boolean {
  const report = capability.verification;
  return report.schema && report.authenticated && report.replayPasses >= 3 && report.noSecretLeakage && report.browserExecution && report.selectionScore >= 18;
}

export function transitionCapability(capability: Capability, event: CapabilityEvent): Capability {
  if (capability.safety.riskTier === "R3") return { ...capability, status: "blocked" };
  if (event === "review_approved") return { ...capability, status: "reviewed" };
  if (event === "verification_passed") {
    return { ...capability, verification: { schema: true, authenticated: true, replayPasses: 3, noSecretLeakage: true, browserExecution: true, selectionScore: 20 }, status: "verified" };
  }
  return { ...capability, status: capability.status === "verified" && verified(capability) ? "production_ready" : capability.status };
}
