import { compileWebMcpRelease } from "../../../../../../packages/compiler/src/compiler";

export const runtime = "nodejs";

const capabilities = [
  { name: "find_order", description: "Find an order by ID or customer email.", readOnly: true, inputSchema: { type: "object" as const, properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false as const } },
  { name: "get_order_status", description: "Get shipment status for an order.", readOnly: true, untrustedContent: true, inputSchema: { type: "object" as const, properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false as const } },
  { name: "create_support_ticket", description: "Create a support ticket for an existing order.", readOnly: false, requiresConfirmation: true, inputSchema: { type: "object" as const, properties: { orderId: { type: "string", minLength: 1 }, title: { type: "string", minLength: 3, maxLength: 120 }, priority: { type: "string", enum: ["low", "medium", "high"] } }, required: ["orderId", "title", "priority"], additionalProperties: false as const } }
];

export function GET(request: Request) {
  const release = compileWebMcpRelease(capabilities, new URL(request.url).origin);
  return new Response(release.code, {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "text/javascript; charset=utf-8",
      etag: release.contentHash,
      "x-page2webmcp-content-hash": release.contentHash
    }
  });
}
