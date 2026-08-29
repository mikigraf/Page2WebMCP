import { createHash } from "node:crypto";
import { getControlPlaneRepository } from "../../../../../packages/database/src/factory.ts";
import {
  ApiError,
  assertSameOrigin,
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireActor,
  successResponse
} from "../../../src/api.ts";
import { normalizeProjectInput, ProjectInputSchema } from "../../../src/projects.ts";
import { recordLifecycle, recordLifecycleFailure } from "../../../src/telemetry.ts";

const IDEMPOTENCY_KEY = /^[a-zA-Z0-9._:-]{8,128}$/;

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const actor = requireActor(request);
    const projects = await getControlPlaneRepository().listProjects(actor);
    return successResponse({ projects }, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  try {
    assertSameOrigin(request);
    const actor = requireActor(request);
    const input = await parseJsonBody(request, ProjectInputSchema);
    const normalized = normalizeProjectInput(input);
    if (!normalized.ok) throw new ApiError(normalized.code, 400);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const inputHash = createHash("sha256").update(JSON.stringify(normalized.value)).digest("hex");
    const project = await getControlPlaneRepository().createProject(actor, {
      ...normalized.value,
      idempotencyKey,
      inputHash
    });
    await recordLifecycle({
      event: "project_created",
      outcome: "success",
      requestId,
      properties: { source_type: project.sourceType, duration_ms: Date.now() - startedAt }
    });
    return successResponse(project, requestId, 201);
  } catch (error) {
    const response = errorResponse(error, requestId);
    await recordLifecycleFailure({ event: "project_created", requestId, startedAt }, error, response.status);
    return response;
  }
}
