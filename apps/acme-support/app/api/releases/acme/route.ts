import { compileWebMcpRelease } from "../../../../../../packages/compiler/src/compiler";
import { acmeCapabilityPlans } from "../../../../src/capability-plans";

export const runtime = "nodejs";

function releaseOrigin(): string {
  const value = process.env.PAGE2WEBMCP_ACME_PUBLIC_ORIGIN ?? "http://127.0.0.1:3200";
  const origin = new URL(value);
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.origin !== value) throw new Error("INVALID_RELEASE_ORIGIN");
  return origin.origin;
}

export function GET() {
  try {
    const release = compileWebMcpRelease(acmeCapabilityPlans(releaseOrigin()));
    return new Response(release.code, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
        etag: `"${release.contentHash}"`,
        "x-page2webmcp-content-hash": release.contentHash,
        "x-page2webmcp-integrity": release.integrity,
      }
    });
  } catch {
    return Response.json({ code: "CONFIG_INVALID" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
