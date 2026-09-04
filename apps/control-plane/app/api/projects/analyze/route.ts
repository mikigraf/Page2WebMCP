import { createHash } from "node:crypto";
import { z } from "zod";
import {
  InMemoryControlPlaneRepository,
  type AnalysisRunRecord,
} from "../../../../../../packages/database/src/control-plane.ts";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { processNextAnalysis } from "../../../../../worker/src/runner.ts";
import { createLocalFixtureAnalysisAdapter } from "../../../../../worker/src/local-fixture.ts";
import {
  ApiError,
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireMutationActor,
  successResponse
} from "../../../../src/api.ts";
import {
  loadWebsiteUserHandoffBinding,
  websiteUserHandoffApiError,
} from "../../../../src/website-user-handoff-api.ts";
import { websiteUserHandoffPort } from "../../../../src/website-user-handoff.ts";
import { localFixtureRuntimeEnabled } from "../../../../src/local-runtime.ts";

const AnalyzeInputSchema = z.object({ projectId: z.string().uuid() }).strict();
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9._:-]{8,128}$/;

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireMutationActor(request, repository);
    const input = await parseJsonBody(request, AnalyzeInputSchema);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400);

    const idempotency = {
      projectId: input.projectId,
      idempotencyKey,
      inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    };
    const project = await repository.getProject(actor, input.projectId);
    const localFixture = localFixtureRuntimeEnabled();
    let run: AnalysisRunRecord | undefined;
    if (project.sourceType === "website" && !localFixture) {
      run = await repository.getAnalysisReplay(actor, idempotency);
      if (!run) {
        const binding = await loadWebsiteUserHandoffBinding(repository, actor, project.id);
        const ownership = await websiteUserHandoffPort().ownershipStatus(binding, request.signal);
        if (ownership.state !== "verified") throw new ApiError("WEBSITE_OWNERSHIP_REQUIRED", 409);
        run = await repository.enqueueAnalysis(actor, {
          ...idempotency,
          expectedSource: {
            projectSourceId: binding.projectSourceId,
            sourceSnapshotId: binding.sourceSnapshotId,
            sourceIdentityHash: binding.sourceIdentityHash,
          },
        });
      }
    } else {
      run = await repository.enqueueAnalysis(actor, idempotency);
    }
    if (!run) throw new ApiError("INVALID_STATE", 409);

    // The fixture adapter has no external process, but still exercises the same
    // durable claim/lease/completion protocol as the PostgreSQL worker.
    if (repository instanceof InMemoryControlPlaneRepository && run.status === "queued") {
      for (let processed = 0; processed < 256; processed += 1) {
        const target = await repository.getAnalysis(actor, run.id);
        if (target.status !== "queued") break;
        if (!await processNextAnalysis(repository, localFixture
          ? { analyze: createLocalFixtureAnalysisAdapter() }
          : undefined)) break;
      }
    }
    const current = await repository.getAnalysis(actor, run.id);
    return successResponse({ runId: current.id, status: current.status }, requestId, 202);
  } catch (error) {
    return errorResponse(websiteUserHandoffApiError(error), requestId, request);
  }
}
