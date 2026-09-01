import { AcmeSupport } from "../apps/acme-support/src/app.ts";
import { acmeCapabilityPlans } from "../apps/acme-support/src/capability-plans.ts";
import { createCapability, type Capability } from "../packages/capability-ir/src/status.ts";
import { compileWebMcpRelease, type CompiledRelease } from "../packages/compiler/src/compiler.ts";

export type FixtureWorkflowResult = {
  capabilities: Capability[];
  release: CompiledRelease;
};

export function runFixtureWorkflow(_app: AcmeSupport, origin: string): FixtureWorkflowResult {
  const capabilities = [
    createCapability("find_order", "R0", true),
    createCapability("get_order_status", "R0", true),
    createCapability("create_support_ticket", "R1", false),
    createCapability("delete_account", "R3", false),
  ];
  const executableNames = new Set(capabilities
    .filter((capability) => capability.status !== "blocked")
    .map((capability) => capability.identity.name));
  return {
    capabilities,
    release: compileWebMcpRelease(acmeCapabilityPlans(origin).filter((plan) => executableNames.has(plan.tool.name))),
  };
}
