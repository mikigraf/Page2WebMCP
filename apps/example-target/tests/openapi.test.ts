import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { openApiDocument } from "../src/openapi.ts";

const apiDirectory = fileURLToPath(new URL("../app/api", import.meta.url));

async function implementedRoutes(directory: string, prefix = "/api"): Promise<Map<string, string[]>> {
  const routes = new Map<string, string[]>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const segment = entry.name.replace(/^\[(.+)\]$/, "{$1}");
      for (const [route, methods] of await implementedRoutes(child, `${prefix}/${segment}`)) routes.set(route, methods);
      continue;
    }
    if (entry.name !== "route.ts") continue;
    const source = await readFile(child, "utf8");
    const methods = [...source.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)]
      .map((match) => match[1].toLowerCase())
      .sort();
    routes.set(prefix, methods);
  }
  return routes;
}

test("the example target OpenAPI document is standards-valid OpenAPI 3.1", async () => {
  const document = openApiDocument();
  assert.equal(document.openapi, "3.1.0");
  await assert.doesNotReject(SwaggerParser.validate(structuredClone(document) as never));
});

test("the OpenAPI document describes exactly the implemented API routes and methods", async () => {
  const document = openApiDocument() as unknown as { paths: Record<string, Record<string, unknown>> };
  const routes = await implementedRoutes(apiDirectory);
  assert.deepEqual(Object.keys(document.paths).sort(), [...routes.keys()].sort());
  for (const [route, methods] of routes) {
    assert.deepEqual(Object.keys(document.paths[route]).sort(), methods, `${route} methods match`);
  }
});

test("the document declares cookie session security, an authenticated read, and a confirmed reversible mutation", () => {
  const document = openApiDocument() as unknown as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: { securitySchemes: Record<string, { type: string; in: string; name: string }> };
  };
  const scheme = document.components.securitySchemes.partsConsoleSession;
  assert.deepEqual(scheme, { type: "apiKey", in: "cookie", name: "parts_console_session" });

  const read = document.paths["/api/parts"].get;
  assert.equal(read.operationId, "listParts");
  assert.deepEqual(read.security, [{ partsConsoleSession: [] }]);

  const reserve = document.paths["/api/reservations"].post;
  assert.equal(reserve.operationId, "reservePartStock");
  assert.deepEqual(reserve.security, [{ partsConsoleSession: [] }]);
  // The reviewed effect declares the request token and idempotency header; a
  // capability compiler supplies them, so the operation declares no parameters.
  assert.equal(reserve.parameters, undefined);

  const release = document.paths["/api/reservations/{id}"].delete;
  assert.equal(release.operationId, "releasePartStock");
  assert.equal(document.paths["/api/reservations/{id}"].get.operationId, "getReservation");
  assert.deepEqual(release.security, [{ partsConsoleSession: [] }]);
  assert.equal(document.paths["/api/account"].delete.operationId, "deleteAccount");
});

test("every documented operation declares responses and every schema is referenced", () => {
  const document = openApiDocument() as unknown as {
    paths: Record<string, Record<string, { responses?: unknown }>>;
    components: { schemas: Record<string, unknown> };
  };
  for (const [route, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      assert.ok(operation.responses, `${method} ${route} declares responses`);
    }
  }
  const serialized = JSON.stringify(document.paths) + JSON.stringify(document.components.schemas);
  for (const name of Object.keys(document.components.schemas)) {
    assert.ok(serialized.includes(`#/components/schemas/${name}`), `${name} is referenced`);
  }
});

test("any revision path serves the identical description", async () => {
  const { GET: canonical } = await import("../app/openapi.json/route.ts");
  const { GET: revision } = await import("../app/openapi/[revision]/route.ts");
  assert.deepEqual(await revision().json(), await canonical().json());
});
