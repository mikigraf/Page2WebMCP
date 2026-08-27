import test from "node:test";
import assert from "node:assert/strict";
import { compileOpenApi, parseOpenApiDocument } from "./compile.ts";

test("groups Acme OpenAPI operations and blocks destructive operations", () => {
  const result = compileOpenApi({ openapi: "3.1.0", paths: {
    "/api/orders": { get: { operationId: "findOrder", summary: "Find order" } },
    "/api/orders/{id}": { get: { operationId: "getOrderStatus", summary: "Get order status" } },
    "/api/tickets": { post: { operationId: "createSupportTicket", summary: "Create ticket" } },
    "/api/account": { delete: { operationId: "deleteAccount", summary: "Delete account" } }
  } });
  assert.deepEqual(result.capabilities.map((item) => [item.name, item.risk]), [["find_order", "R0"], ["get_order_status", "R0"], ["create_support_ticket", "R1"]]);
  assert.deepEqual(result.diagnostics, [{ code: "HIGH_RISK_OPERATION_BLOCKED", operationId: "deleteAccount" }]);
});

test("parses JSON and YAML OpenAPI 3.0 through 3.2 while blocking external references", () => {
  const yaml = `openapi: 3.2.0
paths:
  /api/orders:
    get:
      operationId: findOrder
      summary: Find an order
`;
  assert.equal(parseOpenApiDocument(yaml, "yaml").openapi, "3.2.0");
  assert.equal(parseOpenApiDocument('{"openapi":"3.0.3","paths":{}}', "json").openapi, "3.0.3");
  assert.throws(() => parseOpenApiDocument('openapi: 3.1.0\npaths:\n  /x:\n    $ref: https://attacker.example/spec.yaml', "yaml"), /EXTERNAL_REFERENCE_BLOCKED/);
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.1.0"}', "json"), /INVALID_OPENAPI_DOCUMENT/);
});
