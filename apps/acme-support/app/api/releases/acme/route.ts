import { compileWebMcpRelease, type CompilableCapability } from "../../../../../../packages/compiler/src/compiler";

export const runtime = "nodejs";

const capabilities: CompilableCapability[] = [
  {
    name: "find_order", description: "Find an order by ID or customer email.", readOnly: true,
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 120 } }, required: ["query"], additionalProperties: false },
    requestPlan: { method: "GET", path: "/api/orders", query: { q: "query" } },
    outputSchema: { type: "array", maxItems: 100, items: { type: "object", properties: { id: { type: "string" }, email: { type: "string" }, shipmentStatus: { type: "string" } }, required: ["id", "email", "shipmentStatus"], additionalProperties: false } },
  },
  {
    name: "get_order_status", description: "Get shipment status for an order.", readOnly: true, untrustedContent: true,
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 64 } }, required: ["query"], additionalProperties: false },
    requestPlan: { method: "GET", path: "/api/orders/{query}" },
    outputSchema: { type: "object", properties: { orderId: { type: "string" }, shipmentStatus: { type: "string" }, customerNotes: { type: "string" }, untrustedContent: { type: "boolean" } }, required: ["orderId", "shipmentStatus", "customerNotes", "untrustedContent"], additionalProperties: false },
  },
  {
    name: "create_support_ticket", description: "Create a support ticket for an existing order.", readOnly: false, requiresConfirmation: true,
    inputSchema: { type: "object", properties: { orderId: { type: "string", minLength: 1, maxLength: 64 }, title: { type: "string", minLength: 3, maxLength: 120 }, priority: { type: "string", enum: ["low", "medium", "high"] } }, required: ["orderId", "title", "priority"], additionalProperties: false },
    requestPlan: { method: "POST", path: "/api/tickets", body: ["orderId", "title", "priority"] },
    outputSchema: { type: "object", properties: { ticketId: { type: "string" }, status: { type: "string", enum: ["open"] }, priority: { type: "string", enum: ["low", "medium", "high"] }, createdAt: { type: "string" } }, required: ["ticketId", "status", "priority", "createdAt"], additionalProperties: false },
  },
];

function releaseOrigin(): string {
  const value = process.env.PAGE2WEBMCP_ACME_PUBLIC_ORIGIN ?? "http://127.0.0.1:3200";
  const origin = new URL(value);
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.origin !== value) throw new Error("INVALID_RELEASE_ORIGIN");
  return origin.origin;
}

export function GET() {
  try {
    const release = compileWebMcpRelease(capabilities, releaseOrigin());
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
