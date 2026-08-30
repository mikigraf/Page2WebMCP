import { createHash } from "node:crypto";
import { z } from "zod";
import { InMemoryControlPlaneRepository } from "../../../../../../packages/database/src/control-plane.ts";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { processNextAnalysis } from "../../../../../worker/src/runner.ts";
import {
  ApiError,
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireMutationActor,
  successResponse
} from "../../../../src/api.ts";

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

    await repository.getProject(actor, input.projectId);
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const run = await repository.enqueueAnalysis(actor, {
      projectId: input.projectId,
      idempotencyKey,
      inputHash
    });

    // The fixture adapter has no external process, but still exercises the same
    // durable claim/lease/completion protocol as the PostgreSQL worker.
    if (repository instanceof InMemoryControlPlaneRepository && run.status === "queued") {
      for (let processed = 0; processed < 256; processed += 1) {
        const target = await repository.getAnalysis(actor, run.id);
        if (target.status !== "queued") break;
        if (!await processNextAnalysis(repository)) break;
      }
    }
    const current = await repository.getAnalysis(actor, run.id);
    return successResponse({ runId: current.id, status: current.status }, requestId, 202);
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
