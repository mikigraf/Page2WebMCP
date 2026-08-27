import { parseDocument } from "yaml";

type Operation = { operationId?: string; summary?: string };
type Document = { openapi: string; paths: Record<string, Partial<Record<"get" | "post" | "put" | "patch" | "delete", Operation>>> };
export type OpenApiCapability = { name: string; risk: "R0" | "R1"; operations: string[] };

const names: Record<string, { name: string; risk: "R0" | "R1" }> = {
  findOrder: { name: "find_order", risk: "R0" }, getOrderStatus: { name: "get_order_status", risk: "R0" }, createSupportTicket: { name: "create_support_ticket", risk: "R1" }
};

function hasExternalReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExternalReference);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => key === "$ref" && typeof child === "string" && /^(https?:)?\/\//i.test(child) || hasExternalReference(child));
}

export function parseOpenApiDocument(source: string, format: "json" | "yaml"): Document {
  let parsed: unknown;
  try {
    if (format === "json") parsed = JSON.parse(source);
    else {
      const document = parseDocument(source, { uniqueKeys: true });
      if (document.errors.length > 0) throw new Error("INVALID_OPENAPI_DOCUMENT");
      parsed = document.toJS();
    }
  } catch {
    throw new Error("INVALID_OPENAPI_DOCUMENT");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).openapi !== "string" || !(parsed as Record<string, unknown>).paths || typeof (parsed as Record<string, unknown>).paths !== "object" || Array.isArray((parsed as Record<string, unknown>).paths)) throw new Error("INVALID_OPENAPI_DOCUMENT");
  if (hasExternalReference(parsed)) throw new Error("EXTERNAL_REFERENCE_BLOCKED");
  return parsed as Document;
}

export function compileOpenApi(document: Document): { capabilities: OpenApiCapability[]; diagnostics: Array<{ code: "HIGH_RISK_OPERATION_BLOCKED"; operationId: string }> } {
  if (!/^3\.(0|1|2)\./.test(document.openapi)) throw new Error("UNSUPPORTED_OPENAPI_VERSION");
  const capabilities: OpenApiCapability[] = []; const diagnostics: Array<{ code: "HIGH_RISK_OPERATION_BLOCKED"; operationId: string }> = [];
  for (const item of Object.values(document.paths)) for (const [method, operation] of Object.entries(item)) {
    const operationId = operation?.operationId; if (!operationId) continue;
    if (method === "delete" || /delete|payment|password|permission/i.test(operationId)) { diagnostics.push({ code: "HIGH_RISK_OPERATION_BLOCKED", operationId }); continue; }
    const target = names[operationId]; if (target) capabilities.push({ ...target, operations: [operationId] });
  }
  return { capabilities, diagnostics };
}
