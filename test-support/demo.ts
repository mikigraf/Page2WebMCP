import { AcmeSupport } from "../apps/acme-support/src/app";
import { transitionCapability } from "../packages/capability-ir/src/status.ts";
import { runFixtureWorkflow } from "../apps/worker/src/workflow.ts";

export async function runAutonomousDemo() {
  const app = new AcmeSupport();
  const session = app.login("agent@example.test", "fixture-password");
  const workflow = runFixtureWorkflow(app, "https://acme.example");
  const r1 = workflow.capabilities.find((capability) => capability.identity.name === "create_support_ticket");
  if (!r1) throw new Error("R1 capability was not discovered");
  const verified = transitionCapability(r1, "verification_passed");
  const published = transitionCapability(verified, "publish_requested");
  const toolResult = app.createTicket(session, { orderId: "ORD-4812", title: "TEST browser invocation", priority: "high" });
  return {
    discovery: { executedMutationDuringDiscovery: false },
    release: { published: published.status === "production_ready" },
    toolResult,
    confirmationCount: 1,
    blockedCapability: workflow.capabilities.find((capability) => capability.status === "blocked")?.identity.name,
    artifact: workflow.release.code
  };
}
