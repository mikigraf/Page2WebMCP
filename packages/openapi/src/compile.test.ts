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

test("allows recursive local schemas while rejecting resource-exhaustion documents", () => {
  assert.equal(
    parseOpenApiDocument('{"openapi":"3.1.0","paths":{},"components":{"schemas":{"Node":{"type":"object","properties":{"child":{"$ref":"#/components/schemas/Node"}}}}}}', "json").openapi,
    "3.1.0"
  );
  const deepYaml = `openapi: 3.1.0\npaths:\n${Array.from({ length: 80 }, (_, depth) => `${"  ".repeat(depth + 1)}nested:`).join("\n")}\n${"  ".repeat(81)}value: x`;
  assert.throws(() => parseOpenApiDocument(deepYaml, "yaml"), /OPENAPI_RESOURCE_LIMIT_EXCEEDED/);
});

test("rejects external, invalid, oversized, and excessive-node OpenAPI input without exposing source", () => {
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.1.0","paths":{"/x":{"$ref":"other.yaml#/x"}}}', "json"), /^Error: EXTERNAL_REFERENCE_BLOCKED$/);
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.1.0","paths":{"/x":{"$ref":"#/missing"}}}', "json"), /^Error: LOCAL_REFERENCE_INVALID$/);
  assert.throws(() => parseOpenApiDocument(`{"openapi":"3.1.0","paths":{},"x":"${"x".repeat(1_000_000)}"}`, "json"), /^Error: OPENAPI_RESOURCE_LIMIT_EXCEEDED$/);
  const excessiveNodes = JSON.stringify({ openapi: "3.1.0", paths: {}, values: Array.from({ length: 10_100 }, (_, index) => index) });
  assert.throws(() => parseOpenApiDocument(excessiveNodes, "json"), /^Error: OPENAPI_RESOURCE_LIMIT_EXCEEDED$/);
});

test("visits acyclic local-reference DAGs once", () => {
  const components: Record<string, unknown> = {};
  for (let index = 0; index < 15; index++) {
    const next = `#/components/node${index + 1}`;
    components[`node${index}`] = index === 14 ? { type: "string" } : { left: { $ref: next }, right: { $ref: next } };
  }
  const source = JSON.stringify({ openapi: "3.1.0", paths: {}, components });
  assert.equal(parseOpenApiDocument(source, "json").openapi, "3.1.0");
});

test("allows bounded local references into OpenAPI arrays", () => {
  const source = JSON.stringify({
    openapi: "3.1.0",
    paths: { "/x": { get: { parameters: [{ $ref: "#/components/parameters/0" }] } } },
    components: { parameters: [{ name: "limit", in: "query" }] }
  });
  assert.equal(parseOpenApiDocument(source, "json").openapi, "3.1.0");
});

test("accepts bounded YAML aliases that share a safe object", () => {
  const source = `openapi: 3.1.0
paths: {}
components:
  primary: &parameter
    name: limit
    in: query
  alias: *parameter
`;
  assert.equal(parseOpenApiDocument(source, "yaml").openapi, "3.1.0");
});

test("rejects malformed path items and operations and unsupported OpenAPI versions", () => {
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.1.0","paths":{"/x":null}}', "json"), /^Error: INVALID_OPENAPI_DOCUMENT$/);
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.1.0","paths":{"/x":{"get":null}}}', "json"), /^Error: INVALID_OPENAPI_DOCUMENT$/);
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.1.0","paths":{"/x":{"post":"not-an-operation"}}}', "json"), /^Error: INVALID_OPENAPI_DOCUMENT$/);
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.1","paths":{}}', "json"), /^Error: INVALID_OPENAPI_DOCUMENT$/);
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.3.0","paths":{}}', "json"), /^Error: UNSUPPORTED_OPENAPI_VERSION$/);
});

test("decodes RFC 6901 local reference fragments and rejects malformed escapes", () => {
  const valid = '{"openapi":"3.1.0","paths":{"/x":{"$ref":"#/components/schemas/Foo%20Bar"}},"components":{"schemas":{"Foo Bar":{"type":"object"}}}}';
  assert.equal(parseOpenApiDocument(valid, "json").openapi, "3.1.0");
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.1.0","paths":{"/x":{"$ref":"#/components/schemas/%ZZ"}},"components":{"schemas":{}}}', "json"), /^Error: LOCAL_REFERENCE_INVALID$/);
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.1.0","paths":{"/x":{"$ref":"#/components/schemas/a~2b"}},"components":{"schemas":{"a~2b":{"type":"object"}}}}', "json"), /^Error: LOCAL_REFERENCE_INVALID$/);
});

test("allows x-* Paths Object extensions while validating actual path items", () => {
  assert.equal(parseOpenApiDocument('{"openapi":"3.1.0","paths":{"x-gateway":{"enabled":true},"/x":{"get":{"operationId":"findOrder"}}}}', "json").openapi, "3.1.0");
  assert.throws(() => parseOpenApiDocument('{"openapi":"3.1.0","paths":{"not-a-path":{}}}', "json"), /^Error: INVALID_OPENAPI_DOCUMENT$/);
});
