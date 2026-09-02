import { parseOwnershipVerification } from "../../../src/ownership-verification";

export const dynamic = "force-dynamic";

/** Serves the website-ownership challenge the control plane asked this site to publish. */
export function GET(): Response {
  const content = parseOwnershipVerification(process.env);
  if (content === null) {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return new Response(content, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
