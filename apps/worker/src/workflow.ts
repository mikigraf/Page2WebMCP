import { AcmeSupport } from "../../acme-support/src/app";
import { Capability, createCapability } from "../../../packages/capability-ir/src/status.ts";
import { compileWebMcpRelease, CompiledRelease } from "../../../packages/compiler/src/compiler.ts";
import { sanitizeEvidence } from "../../../packages/security/src/security.ts";
import { compileOpenApi } from "../../../packages/openapi/src/compile.ts";
import { analyzeSource, generateHardeningChange } from "../../../packages/source-analyzer/src/analyze.ts";
import { LocalSourceControlProvider } from "../../../packages/providers/src/local.ts";

export type WorkflowResult = { capabilities: Capability[]; evidence: Array<Record<string, unknown>>; release: CompiledRelease };

export function runFixtureWorkflow(app: AcmeSupport, origin: string): WorkflowResult {
  const document = app.openApiDocument();
  const capabilitySpecs = [
    ["find_order", "R0", true],
    ["get_order_status", "R0", true],
    ["create_support_ticket", "R1", false],
    ["delete_account", "R3", false]
  ] as const;
  const openApi = compileOpenApi(document);
  const capabilities = capabilitySpecs.map(([name, risk, readOnly]) => createCapability(name, risk, readOnly));
  const evidence = Object.entries(document.paths).map(([path, operations]) => sanitizeEvidence({ source: "openapi", path, operations }));
  const release = compileWebMcpRelease(capabilities.filter((capability) => capability.status !== "blocked").map((capability) => ({
    name: capability.identity.name,
    description: capability.identity.name.replaceAll("_", " "),
    readOnly: capability.safety.readOnly
  })), origin);
  return { capabilities, evidence: [...evidence, { source: "openapi", diagnostics: openApi.diagnostics }], release };
}

export function runFixtureSourceHardening() {
  const analysis = analyzeSource({
    "app/api/tickets/route.ts": "export async function POST() { return acme.createTicket(session(request), await request.json()); }",
    "app/api/_fixture.ts": "export function session(request) { return request.cookies.get('acme_session'); }"
  });
  const source = new LocalSourceControlProvider();
  return source.openDraftPullRequest({ title: "feat: add Page2WebMCP tools", files: generateHardeningChange(analysis) });
}
