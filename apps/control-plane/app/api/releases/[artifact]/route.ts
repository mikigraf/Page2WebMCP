import { createHash } from "node:crypto";
import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { ApiError, createRequestId, errorResponse } from "../../../../src/api.ts";

const ArtifactSchema = z.string().regex(/^[0-9a-f]{64}\.js$/);

export async function GET(
  request: Request,
  context: { params: Promise<{ artifact: string }> }
) {
  const requestId = createRequestId();
  try {
    const { artifact: rawArtifact } = await context.params;
    const artifact = ArtifactSchema.safeParse(rawArtifact);
    if (!artifact.success) throw new ApiError("NOT_FOUND", 404);
    const contentHash = artifact.data.slice(0, -3);
    const release = await getControlPlaneRepository().getReleaseArtifact(contentHash);
    const bytes = Buffer.from(release.code);
    const digest = createHash("sha256").update(bytes).digest();
    const integrity = createHash("sha384").update(bytes).digest("base64");
    if (digest.toString("hex") !== contentHash
      || release.contentHash !== contentHash
      || release.sri !== `sha384-${integrity}`) {
      throw new ApiError("ARTIFACT_INTEGRITY_FAILED", 500);
    }
    const etag = `"${release.contentHash}"`;
    const headers = new Headers({
      "access-control-allow-origin": release.allowedOrigin,
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "text/javascript; charset=utf-8",
      "cross-origin-resource-policy": "cross-origin",
      etag,
      "x-content-type-options": "nosniff",
      "x-page2webmcp-content-hash": release.contentHash,
      "x-page2webmcp-integrity": release.sri,
      "x-request-id": requestId
    });
    if (new URL(request.url).searchParams.get("download") === "1") {
      headers.set("content-disposition", `attachment; filename="page2webmcp-${release.contentHash}.js"`);
    }
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(release.code, { status: 200, headers });
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
