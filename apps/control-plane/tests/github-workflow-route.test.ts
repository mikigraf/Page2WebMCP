import assert from "node:assert/strict";
import test from "node:test";
import { GET as getWorkflow } from "../app/api/workflow-runs/[runId]/route.ts";
import { POST as startWorkflow } from "../app/api/projects/[projectId]/workflows/route.ts";
import { InMemoryControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { createGitHubAnalysisAdapter } from "../../worker/src/workflow.ts";
import { processNextAnalysis } from "../../worker/src/runner.ts";
import { authenticatedHeaders, installTestRepository, owner } from "./auth-test-helpers.ts";

const now = new Date("2026-08-30T12:00:00.000Z");
const selection = {
  installationId: 41,
  repositoryId: 90210,
  owner: "bright-tools",
  repository: "widget-console",
  ref: "refs/heads/main",
};
const sourceFiles = [
  { path: "app/api/widgets/route.ts", kind: "blob", content: `
    import { z } from "zod";
    import { requireAccount } from "@/lib/auth";
    import { createWidget } from "@/lib/widgets";
    const inputSchema = z.object({ title: z.string().min(3).max(120) });
    const outputSchema = z.object({ id: z.string().max(64) });
    export async function POST(request: Request) {
      const account = await requireAccount(request);
      const input = inputSchema.parse(await request.json());
      return Response.json(outputSchema.parse(await createWidget(account.id, input)), { status: 201 });
    }
  ` },
  { path: "lib/auth.ts", kind: "blob", content: "export function requireAccount(request: Request) { if (!request.headers.get('cookie')) throw new Error('AUTHENTICATION_REQUIRED'); return { id: 'account' }; }" },
  { path: "lib/widgets.ts", kind: "blob", content: "export async function createWidget() { return { id: 'widget' }; }" },
] as const;

function adapter() {
  return createGitHubAnalysisAdapter({
    targetOrigin: "https://widgets.example",
    clock: () => now,
    installation: { resolve: async () => selection },
    tokens: {
      issue: async () => ({ ...selection, token: "ghs_ephemeral_test_token_abcdefghijklmnopqrstuvwxyz", expiresAt: new Date(now.getTime() + 3_600_000).toISOString() }),
      revoke: async () => undefined,
    },
    snapshot: {
      resolveRef: async () => ({ ...selection, requestedRef: selection.ref, commitSha: "a".repeat(40) }),
      readTree: async ({ commitSha }) => ({ ...selection, requestedRef: selection.ref, commitSha, files: sourceFiles }),
    },
  });
}

test("GitHub workflow API starts only the exact reviewed analysis and exposes durable status without a fabricated PR", async () => {
  const repository = installTestRepository(new InMemoryControlPlaneRepository());
  const project = await repository.createProject(owner, {
    name: "Bright tools widgets",
    sourceType: "github",
    url: "https://github.com/bright-tools/widget-console",
    idempotencyKey: "route-project-github-workflow",
    inputHash: "route-project-github-workflow",
  });
  const analysis = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "route-analysis-github-workflow",
    inputHash: "route-analysis-github-workflow",
  });
  await processNextAnalysis(repository, { workerId: "route-github-analysis", analyze: adapter() });
  const result = await repository.getAnalysisResult(owner, analysis.id);
  assert.equal(result?.draftPullRequest, undefined);
  const [capability] = await repository.listAnalysisCapabilities(owner, analysis.id);
  assert.ok(capability);
  await repository.reviewCapability(owner, capability.id, { action: "approve", expectedVersion: capability.version });
  const headers = authenticatedHeaders(owner);
  const response = await startWorkflow(new Request(`https://control.example/api/projects/${project.id}/workflows`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": "route-start-github-workflow" },
    body: JSON.stringify({ analysisRunId: analysis.id }),
  }), { params: Promise.resolve({ projectId: project.id }) });
  assert.equal(response.status, 202);
  const started = await response.json();
  assert.equal(started.workflow.reviewedAnalysisRunId, analysis.id);
  assert.equal(started.workflow.status, "queued");
  assert.equal(started.outcome, "tested_patch_draft_pull_request_pending");

  const status = await getWorkflow(new Request(`https://control.example/api/workflow-runs/${started.workflow.id}`, {
    headers: { cookie: headers.cookie },
  }), { params: Promise.resolve({ runId: started.workflow.id }) });
  assert.equal(status.status, 200);
  const current = await status.json();
  assert.equal(current.workflow.reviewedAnalysisRunId, analysis.id);
  assert.deepEqual(current.tasks.map(({ phase }: { phase: string }) => phase), ["preflight"]);
  assert.equal(current.outcome, "tested_patch_draft_pull_request_pending");
});
