export type OpenApiDocument = Readonly<{
  openapi: "3.1.0";
  info: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, unknown>;
}>;

const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const response = (description: string, schema?: Record<string, unknown>) =>
  schema ? { description, content: { "application/json": { schema } } } : { description };

const errors = {
  "400": response("Invalid request", reference("Error")),
  "401": response("Authentication required", reference("Error")),
  "403": response("Action denied", reference("Error")),
  "404": response("Not found", reference("Error")),
  "409": response("Conflicting request", reference("Error")),
  "413": response("Payload too large", reference("Error")),
};

const secured = [{ partsConsoleSession: [] }];

/**
 * The OpenAPI 3.1 contract for the example target. It stays in lockstep with the
 * route handlers under `app/api`; the test suite enforces that.
 */
export function openApiDocument(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: {
      title: "Beacon Parts Console",
      version: "1.0.0",
      description: "Authenticated parts and reservations API for a Page2WebMCP production-live target.",
    },
    paths: {
      "/api/auth/login": {
        post: {
          operationId: "login",
          summary: "Authenticate the parts console operator",
          requestBody: { required: true, content: { "application/json": { schema: reference("LoginInput") } } },
          responses: {
            "200": response("Authenticated", reference("Authentication")),
            "400": errors["400"], "401": errors["401"], "403": errors["403"], "413": errors["413"],
          },
        },
      },
      "/api/auth/logout": {
        post: {
          operationId: "logout",
          summary: "End the parts console operator session",
          security: secured,
          responses: {
            "303": { description: "Session ended; the operator is returned to the console home" },
            "401": errors["401"], "403": errors["403"],
          },
        },
      },
      "/api/parts": {
        get: {
          operationId: "listParts",
          summary: "List catalogue parts with authoritative availability",
          security: secured,
          parameters: [{ name: "q", in: "query", required: false, schema: { type: "string", minLength: 1, maxLength: 120 } }],
          responses: {
            "200": response("Matching parts", { type: "array", maxItems: 100, items: reference("PartSummary") }),
            "400": errors["400"], "401": errors["401"],
          },
        },
      },
      "/api/parts/{sku}": {
        get: {
          operationId: "getPart",
          summary: "Read the authoritative state of one part",
          security: secured,
          parameters: [{ name: "sku", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 64 } }],
          responses: {
            "200": response("Part detail", reference("PartDetail")),
            "400": errors["400"], "401": errors["401"], "404": errors["404"],
          },
        },
      },
      "/api/confirmations": {
        post: {
          operationId: "confirmPartReservation",
          summary: "Issue short-lived confirmation evidence for a reservation",
          security: secured,
          requestBody: { required: true, content: { "application/json": { schema: reference("ConfirmationRequest") } } },
          responses: {
            "201": response("Confirmation evidence", reference("Confirmation")),
            "400": errors["400"], "401": errors["401"], "403": errors["403"], "404": errors["404"], "413": errors["413"],
          },
        },
      },
      "/api/reservations": {
        get: {
          operationId: "listReservations",
          summary: "List the operator's reservations with their authoritative state",
          security: secured,
          responses: {
            "200": response("Reservations", { type: "array", maxItems: 100, items: reference("ReservationState") }),
            "401": errors["401"],
          },
        },
        post: {
          operationId: "reservePartStock",
          summary: "Reserve part stock after explicit confirmation (reversible)",
          security: secured,
          // The reviewed effect a capability compiler needs to propose this as a
          // confirmed, reversible mutation, with the request token it must echo.
          "x-page2webmcp": {
            reviewed: true,
            effect: "mutation",
            riskTier: "R1",
            reversible: true,
            idempotencyHeader: "idempotency-key",
            idempotencyVerified: true,
            csrf: {
              reviewed: true,
              headerName: "x-csrf-token",
              resolution: { kind: "meta", name: "csrf-token" },
            },
          },
          // idempotency-key is declared by the reviewed effect above, not as a
          // parameter: a capability compiler supplies it itself.
          requestBody: { required: true, content: { "application/json": { schema: reference("ReservationInput") } } },
          responses: {
            "201": response("Reservation applied", reference("Reservation")),
            "400": errors["400"], "401": errors["401"], "403": errors["403"],
            "404": errors["404"], "409": errors["409"], "413": errors["413"],
          },
        },
      },
      "/api/reservations/{id}": {
        get: {
          operationId: "getReservation",
          summary: "Read the authoritative final state of a reservation",
          security: secured,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } }],
          responses: {
            "200": response("Reservation state", reference("ReservationState")),
            "400": errors["400"], "401": errors["401"], "404": errors["404"],
          },
        },
        delete: {
          operationId: "releasePartStock",
          summary: "Reverse a reservation and restore the reserved stock",
          security: secured,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } }],
          responses: {
            "200": response("Reservation released", reference("ReservationState")),
            "400": errors["400"], "401": errors["401"], "403": errors["403"], "404": errors["404"],
          },
        },
      },
      "/api/account": {
        delete: {
          operationId: "deleteAccount",
          summary: "Account deletion is permanently blocked",
          security: secured,
          responses: { "401": errors["401"], "403": response("Blocked high-risk action", reference("Error")) },
        },
      },
    },
    components: {
      securitySchemes: { partsConsoleSession: { type: "apiKey", in: "cookie", name: "parts_console_session" } },
      schemas: {
        LoginInput: {
          type: "object", additionalProperties: false, required: ["email", "password"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 254 },
            password: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
        Authentication: {
          type: "object", additionalProperties: false, required: ["authenticated"],
          properties: { authenticated: { type: "boolean" } },
        },
        PartSummary: {
          type: "object", additionalProperties: false, required: ["sku", "name", "available"],
          properties: {
            sku: { type: "string", minLength: 1, maxLength: 64 },
            name: { type: "string" },
            available: { type: "integer", minimum: 0 },
          },
        },
        PartDetail: {
          type: "object", additionalProperties: false,
          required: ["sku", "name", "available", "onHand", "reserved", "supplierNotes", "untrustedContent"],
          properties: {
            sku: { type: "string" }, name: { type: "string" },
            available: { type: "integer", minimum: 0 },
            onHand: { type: "integer", minimum: 0 },
            reserved: { type: "integer", minimum: 0 },
            supplierNotes: { type: "string" },
            untrustedContent: { type: "boolean" },
          },
        },
        ReservationInput: {
          type: "object", additionalProperties: false, required: ["sku", "quantity", "orderReference", "confirmed"],
          properties: {
            sku: { type: "string", minLength: 1, maxLength: 64 },
            quantity: { type: "integer", minimum: 1, maximum: 99 },
            orderReference: { type: "string", minLength: 3, maxLength: 64 },
            confirmed: { type: "boolean" },
          },
        },
        ConfirmationRequest: {
          type: "object", additionalProperties: false, required: ["toolName", "input", "idempotencyKey"],
          properties: {
            toolName: { type: "string", enum: ["reserve_part_stock"] },
            input: reference("ReservationInput"),
            idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
        Confirmation: {
          type: "object", additionalProperties: false, required: ["evidence"],
          properties: { evidence: { type: "string", minLength: 1 } },
        },
        Reservation: {
          type: "object", additionalProperties: false,
          required: ["reservationId", "sku", "quantity", "orderReference", "status", "reversible", "effectCount", "createdAt"],
          properties: {
            reservationId: { type: "string" }, sku: { type: "string" },
            quantity: { type: "integer", minimum: 1, maximum: 99 },
            orderReference: { type: "string" },
            status: { type: "string", enum: ["reserved"] },
            reversible: { type: "boolean" },
            effectCount: { type: "integer", minimum: 1, maximum: 1 },
            createdAt: { type: "string", minLength: 20, maxLength: 40 },
          },
        },
        ReservationState: {
          type: "object", additionalProperties: false,
          required: ["reservationId", "sku", "quantity", "orderReference", "status", "createdAt", "releasedAt"],
          properties: {
            reservationId: { type: "string" }, sku: { type: "string" },
            quantity: { type: "integer", minimum: 1, maximum: 99 },
            orderReference: { type: "string" },
            status: { type: "string", enum: ["reserved", "released"] },
            createdAt: { type: "string", minLength: 20, maxLength: 40 },
            releasedAt: { type: "string", maxLength: 40 },
          },
        },
        Error: {
          type: "object", additionalProperties: false, required: ["code"],
          properties: { code: { type: "string" } },
        },
      },
    },
  };
}
