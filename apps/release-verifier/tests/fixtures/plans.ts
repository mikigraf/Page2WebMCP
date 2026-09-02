import type { CapabilityPlan } from "../../../../packages/capability-ir/src/plan.ts";

const READ_EVIDENCE = "urn:sha256:0c2eee833e857d5b1a893509ec9842c2f1ad886765c30ef4d32a416df2d7bbbc";
const MUTATION_EVIDENCE = "urn:sha256:ab53aa475a9a0f442cb5fae6704794cc9b3a4847a8e419d20c5108a970fd95e7";

const errorMappings = {
  "400": "VALIDATION_FAILED",
  "401": "AUTHENTICATION_REQUIRED",
  "403": "FORBIDDEN",
  "404": "STALE_TARGET",
  "409": "STALE_TARGET",
  "429": "RATE_LIMITED",
  default: "TARGET_ERROR",
} as const;

/** Two reviewed plans shaped like a real release: one authenticated read and one confirmed reversible mutation. */
export function verifierFixturePlans(targetOrigin: string): CapabilityPlan[] {
  return [
    {
      version: 1,
      targetOrigin,
      tool: { name: "find_order", title: "Find order", description: "Find an order by identifier." },
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
            properties: { id: { type: "string" }, title: { type: "string" } },
            required: ["id", "title"],
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
      request: {
        adapter: "json_api",
        method: "GET",
        pathTemplate: "/api/orders",
        path: {},
        query: { q: "query" },
        body: {},
      },
      response: {
        adapter: "json_api",
        contentTypes: ["application/json"],
        projection: { kind: "identity" },
        errorMappings: { ...errorMappings },
      },
      success: { adapter: "json_api", statusCodes: [200], requiredOutputFields: ["id", "title"] },
      evidence: [{ source: "openapi", reference: READ_EVIDENCE }],
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
          },
          required: ["orderId", "title"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { ticketId: { type: "string" }, status: { type: "string", enum: ["open"] } },
          required: ["ticketId", "status"],
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
      },
      idempotency: { strategy: "header", headerName: "idempotency-key", verified: true, retry: "safe_once" },
      request: {
        adapter: "json_api",
        method: "POST",
        pathTemplate: "/api/tickets",
        path: {},
        query: {},
        body: { orderId: "orderId", title: "title" },
      },
      response: {
        adapter: "json_api",
        contentTypes: ["application/json"],
        projection: { kind: "identity" },
        errorMappings: { ...errorMappings },
      },
      success: { adapter: "json_api", statusCodes: [201], requiredOutputFields: ["ticketId", "status"] },
      evidence: [{ source: "openapi", reference: MUTATION_EVIDENCE }],
    },
  ];
}
