import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../../packages/database/src/factory.ts";
import {
  ApiError,
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireActor,
  requireMutationActor,
  successResponse,
} from "../../../../../src/api.ts";
import {
  loadWebsiteUserHandoffBinding,
  publicOwnershipState,
  websiteUserHandoffApiError,
} from "../../../../../src/website-user-handoff-api.ts";
import { websiteUserHandoffPort } from "../../../../../src/website-user-handoff.ts";
import { localFixtureRuntimeEnabled } from "../../../../../src/local-runtime.ts";

const ProjectIdSchema = z.string().uuid();
const MutationSchema = z.object({
  action: z.enum(["challenge", "check"]),
  // Ownership proof the operator can publish; a well-known file works for any site.
  method: z.enum(["well_known", "dns_txt"]).optional(),
}).strict();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireActor(request, repository);
    const projectId = parsedProjectId((await context.params).projectId);
    const binding = await loadWebsiteUserHandoffBinding(repository, actor, projectId);
    const ownership = publicOwnershipState(localFixtureRuntimeEnabled()
      ? { state: "verified" as const, targetOrigin: binding.targetOrigin }
      : await websiteUserHandoffPort().ownershipStatus(binding, request.signal));
    return successResponse({ ownership, canAnalyze: ownership.state === "verified" }, requestId);
  } catch (error) {
    return errorResponse(websiteUserHandoffApiError(error), requestId, request);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireMutationActor(request, repository);
    if (actor.role === "viewer") throw new ApiError("FORBIDDEN", 403);
    const projectId = parsedProjectId((await context.params).projectId);
    const input = await parseJsonBody(request, MutationSchema);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const binding = await loadWebsiteUserHandoffBinding(repository, actor, projectId);
    const state = localFixtureRuntimeEnabled()
      ? { state: "verified" as const, targetOrigin: binding.targetOrigin }
      : await (input.action === "challenge"
        ? websiteUserHandoffPort().issueOwnershipChallenge(binding, idempotencyKey, request.signal, input.method)
        : websiteUserHandoffPort().checkOwnership(binding, idempotencyKey, request.signal));
    const ownership = publicOwnershipState(state);
    return successResponse({ ownership, canAnalyze: ownership.state === "verified" }, requestId);
  } catch (error) {
    return errorResponse(websiteUserHandoffApiError(error), requestId, request);
  }
}

function parsedProjectId(value: string): string {
  const parsed = ProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError("NOT_FOUND", 404);
  return parsed.data;
}
