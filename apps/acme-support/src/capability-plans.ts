import type { CapabilityPlan } from "../../../packages/capability-ir/src/plan.ts";

const FIND_ORDER_EVIDENCE = "urn:sha256:0c2eee833e857d5b1a893509ec9842c2f1ad886765c30ef4d32a416df2d7bbbc";
const ORDER_STATUS_EVIDENCE = "urn:sha256:54cd9d3421215e979a934bcec96374cf6bef35431d2597b49a52235d2f98aac4";
const CREATE_TICKET_EVIDENCE = "urn:sha256:ab53aa475a9a0f442cb5fae6704794cc9b3a4847a8e419d20c5108a970fd95e7";
const CREATE_TICKET_SOURCE_EVIDENCE = "urn:sha256:d74d8d0acf61199d7cc2d81a2ae3c812352901a424458708a919257abd78cdcc";

export function acmeCapabilityEvidence() {
  return [
    { source: "openapi" as const, content: "acme:find_order:openapi:v1", reference: FIND_ORDER_EVIDENCE },
    { source: "runtime" as const, content: "acme:get_order_status:runtime:v1", reference: ORDER_STATUS_EVIDENCE },
    { source: "openapi" as const, content: "acme:create_support_ticket:openapi:v1", reference: CREATE_TICKET_EVIDENCE },
    { source: "github" as const, content: "acme:create_support_ticket:github:v1", reference: CREATE_TICKET_SOURCE_EVIDENCE },
  ];
}

const commonErrors = {
  "400": "VALIDATION_FAILED",
  "401": "AUTHENTICATION_REQUIRED",
  "403": "FORBIDDEN",
  "404": "STALE_TARGET",
  "409": "STALE_TARGET",
  "413": "VALIDATION_FAILED",
  "429": "RATE_LIMITED",
  default: "TARGET_ERROR",
} as const;

export function acmeCapabilityPlans(targetOrigin: string): CapabilityPlan[] {
  return [
    {
      version: 1,
      targetOrigin,
      tool: {
        name: "find_order",
        title: "Find order",
        description: "Find an order by ID or customer email.",
      },
      schemas: {
        input: {
          type: "object",
          properties: { query: { type: "string", minLength: 1, maxLength: 120 } },
          required: ["query"],
          additionalProperties: false,
        },
        output: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              email: { type: "string" },
              shipmentStatus: { type: "string" },
            },
            required: ["id", "email", "shipmentStatus"],
            additionalProperties: false,
          },
        },
      },
      annotations: { readOnly: true, untrusted: false },
      authentication: { mode: "same_origin_cookie", requiredScopes: [] },
      effects: {
        kind: "read",
        riskTier: "R0",
        reversible: true,
        summary: "Reads order summaries without changing them.",
        confirmation: "none",
      },
      idempotency: { strategy: "none", verified: false, retry: "safe_once" },
      request: { method: "GET", pathTemplate: "/api/orders", path: {}, query: { q: "query" }, body: {} },
      response: {
        contentTypes: ["application/json"],
        projection: { kind: "identity" },
        errorMappings: { ...commonErrors },
      },
      success: { statusCodes: [200], requiredOutputFields: ["id", "email", "shipmentStatus"] },
      evidence: [{ source: "openapi", reference: FIND_ORDER_EVIDENCE }],
    },
    {
      version: 1,
      targetOrigin,
      tool: {
        name: "get_order_status",
        title: "Get order status",
        description: "Get shipment status for an order.",
      },
      schemas: {
        input: {
          type: "object",
          properties: { query: { type: "string", minLength: 1, maxLength: 64 } },
          required: ["query"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            orderId: { type: "string" },
            shipmentStatus: { type: "string" },
            customerNotes: { type: "string" },
            untrustedContent: { type: "boolean" },
          },
          required: ["orderId", "shipmentStatus", "customerNotes", "untrustedContent"],
          additionalProperties: false,
        },
      },
      annotations: { readOnly: true, untrusted: true },
      authentication: { mode: "same_origin_cookie", requiredScopes: [] },
      effects: {
        kind: "read",
        riskTier: "R0",
        reversible: true,
        summary: "Reads one order's shipment status without changing it.",
        confirmation: "none",
      },
      idempotency: { strategy: "none", verified: false, retry: "safe_once" },
      request: {
        method: "GET",
        pathTemplate: "/api/orders/{orderId}",
        path: { orderId: "query" },
        query: {},
        body: {},
      },
      response: {
        contentTypes: ["application/json"],
        projection: { kind: "identity" },
        errorMappings: { ...commonErrors },
      },
      success: {
        statusCodes: [200],
        requiredOutputFields: ["orderId", "shipmentStatus", "customerNotes", "untrustedContent"],
      },
      evidence: [{ source: "runtime", reference: ORDER_STATUS_EVIDENCE }],
    },
    {
      version: 1,
      targetOrigin,
      tool: {
        name: "create_support_ticket",
        title: "Create support ticket",
        description: "Create a support ticket for an existing order.",
      },
      schemas: {
        input: {
          type: "object",
          properties: {
            orderId: { type: "string", minLength: 1, maxLength: 64 },
            title: { type: "string", minLength: 3, maxLength: 120 },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["orderId", "title", "priority"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            ticketId: { type: "string" },
            status: { type: "string", enum: ["open"] },
            priority: { type: "string", enum: ["low", "medium", "high"] },
            createdAt: { type: "string" },
          },
          required: ["ticketId", "status", "priority", "createdAt"],
          additionalProperties: false,
        },
      },
      annotations: { readOnly: false, untrusted: false },
      authentication: { mode: "same_origin_cookie", requiredScopes: [] },
      effects: {
        kind: "mutation",
        riskTier: "R1",
        reversible: true,
        summary: "Creates one support ticket that support staff can close.",
        confirmation: "always",
        sourceNativeConfirmation: {
          reviewed: true,
          globalName: "__page2webmcpConfirmSupportTicket",
          evidenceReference: CREATE_TICKET_SOURCE_EVIDENCE,
        },
      },
      idempotency: {
        strategy: "header",
        headerName: "idempotency-key",
        verified: true,
        retry: "safe_once",
      },
      request: {
        method: "POST",
        pathTemplate: "/api/tickets",
        path: {},
        query: {},
        body: { orderId: "orderId", priority: "priority", title: "title" },
      },
      response: {
        contentTypes: ["application/json"],
        projection: { kind: "identity" },
        errorMappings: { ...commonErrors },
      },
      success: { statusCodes: [201], requiredOutputFields: ["ticketId", "status", "priority", "createdAt"] },
      evidence: [
        { source: "openapi", reference: CREATE_TICKET_EVIDENCE },
        { source: "github", reference: CREATE_TICKET_SOURCE_EVIDENCE },
      ],
    },
  ];
}
