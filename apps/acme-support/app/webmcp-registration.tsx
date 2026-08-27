"use client";
import { useEffect } from "react";

type Tool = { name: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: Record<string, string>, context: { signal: AbortSignal }) => Promise<unknown> };
type ModelContext = { registerTool: (tool: Tool, options: { signal: AbortSignal }) => Promise<void> };

function modelContext(): ModelContext | undefined { return (document as Document & { modelContext?: ModelContext }).modelContext; }

async function execute(name: string, input: Record<string, string>, signal: AbortSignal) {
  if (name === "find_order") return fetch(`/api/orders?q=${encodeURIComponent(input.query)}`, { signal }).then((response) => response.json());
  if (name === "get_order_status") return fetch(`/api/orders/${encodeURIComponent(input.query)}`, { signal }).then((response) => response.json());
  const response = await fetch("/api/tickets", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: input.orderId, title: input.title, priority: input.priority }) });
  return response.json();
}

export function WebMCPRegistration() {
  useEffect(() => {
    const context = modelContext();
    if (!context) return;
    const controller = new AbortController();
    const common = { type: "object", additionalProperties: false };
    void Promise.all([
      context.registerTool({ name: "find_order", description: "Find an order by ID or customer email.", inputSchema: { ...common, properties: { query: { type: "string", minLength: 1 } }, required: ["query"] }, annotations: { readOnlyHint: true, untrustedContentHint: false }, execute: (input, { signal }) => execute("find_order", input, signal) }, { signal: controller.signal }),
      context.registerTool({ name: "get_order_status", description: "Get shipment status for an order.", inputSchema: { ...common, properties: { query: { type: "string", minLength: 1 } }, required: ["query"] }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: (input, { signal }) => execute("get_order_status", input, signal) }, { signal: controller.signal }),
      context.registerTool({ name: "create_support_ticket", description: "Create a support ticket for an existing order.", inputSchema: { ...common, properties: { orderId: { type: "string", minLength: 1 }, title: { type: "string", minLength: 3, maxLength: 120 }, priority: { type: "string", enum: ["low", "medium", "high"] } }, required: ["orderId", "title", "priority"] }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: (input, { signal }) => execute("create_support_ticket", input, signal) }, { signal: controller.signal })
    ]);
    return () => controller.abort();
  }, []);
  return null;
}
