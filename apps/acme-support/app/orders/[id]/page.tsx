"use client";
import { FormEvent, useEffect, useRef, useState } from "react";

type Ticket = { ticketId: string; title: string; status: "open"; priority: "low" | "medium" | "high"; createdAt: string };
type TicketInput = { orderId: string; title: string; priority: "high" };
type PendingTicket = { identity: string; idempotencyKey: string; persisted: boolean };
const TICKET_REQUEST_DEADLINE_MS = 15_000;
const PENDING_TICKET_KEY = "page2webmcp.acme.pending-ticket.v1";

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;
}

async function createTicketWithRecovery(
  input: TicketInput,
  idempotencyKey: string,
  evidence: string,
  signal: AbortSignal,
): Promise<Response> {
  const headers = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-page2webmcp-confirmation": evidence,
  };
  const body = JSON.stringify(input);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch("/api/tickets", { method: "POST", headers, body, signal });
      if (!response.ok && retryableStatus(response.status) && attempt === 0) {
        void response.body?.cancel().catch(() => undefined);
        continue;
      }
      return response;
    } catch (error) {
      if (signal.aborted || attempt === 1) throw error;
    }
  }
  throw new Error("Ticket failed");
}

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const [title, setTitle] = useState(""); const [status, setStatus] = useState(""); const [tickets, setTickets] = useState<Ticket[]>([]); const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const pendingTicketRef = useRef<PendingTicket | undefined>(undefined);
  useEffect(() => { void params.then(async ({ id }) => { const response = await fetch(`/api/tickets?orderId=${encodeURIComponent(id)}`); if (response.ok) setTickets(await response.json()); }); }, [params]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: PendingTicket | undefined;
    let finalRequestStarted = false;
    try {
      const { id } = await params;
      const input = { orderId: id, title, priority: "high" as const };
      if (!window.confirm(`Create support ticket?\n\nOrder: ${id}\nTitle: ${title}\nPriority: high`)) {
        setStatus("Ticket creation cancelled");
        return;
      }
      pending = await acquirePendingTicket(input, pendingTicketRef.current);
      pendingTicketRef.current = pending;
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), TICKET_REQUEST_DEADLINE_MS);
      const confirmation = await fetch("/api/confirmations", {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ toolName: "create_support_ticket", input, idempotencyKey: pending.idempotencyKey }),
      });
      if (!confirmation.ok) {
        completePendingTicket(pending);
        pendingTicketRef.current = undefined;
        setStatus("Ticket failed");
        return;
      }
      const { evidence } = await confirmation.json() as { evidence: string };
      finalRequestStarted = true;
      const response = await createTicketWithRecovery(input, pending.idempotencyKey, evidence, controller.signal);
      if (!response.ok) {
        if (!retryableStatus(response.status)) {
          completePendingTicket(pending);
          pendingTicketRef.current = undefined;
        }
        setStatus("Ticket failed");
        return;
      }
      const ticket = await response.json() as Omit<Ticket, "title">;
      completePendingTicket(pending);
      pendingTicketRef.current = undefined;
      setStatus(title);
      setTickets((current) => current.some((item) => item.ticketId === ticket.ticketId)
        ? current
        : [...current, { ...ticket, title }]);
    } catch {
      if (pending && !finalRequestStarted) {
        completePendingTicket(pending);
        pendingTicketRef.current = undefined;
      }
      setStatus("Ticket failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      busyRef.current = false;
      setBusy(false);
    }
  }
  return <main><h1>Order</h1><form onSubmit={create}><label>Ticket title <input value={title} onChange={(event) => setTitle(event.target.value)} /></label><button disabled={busy}>Create ticket</button></form>{status && <p>{status}</p>}<section aria-label="Tickets"><h2>Tickets</h2><ul>{tickets.map((ticket) => <li key={ticket.ticketId}>{ticket.ticketId} — {ticket.title}</li>)}</ul></section></main>;
}

async function acquirePendingTicket(input: TicketInput, current?: PendingTicket): Promise<PendingTicket> {
  const identity = await ticketIdentity(input);
  if (current?.identity === identity) return current;
  const storage = sessionStorageOrUndefined();
  if (!identity.startsWith("memory:")) {
    try {
      const stored = JSON.parse(storage?.getItem(PENDING_TICKET_KEY) ?? "null") as Partial<PendingTicket> | null;
      if (stored?.identity === identity && validIdempotencyKey(stored.idempotencyKey)) {
        return { identity, idempotencyKey: stored.idempotencyKey, persisted: true };
      }
    } catch { /* Replace corrupt recovery state below. */ }
  }
  const pending = { identity, idempotencyKey: crypto.randomUUID(), persisted: !identity.startsWith("memory:") };
  if (pending.persisted) {
    try { storage?.setItem(PENDING_TICKET_KEY, JSON.stringify(pending)); } catch { pending.persisted = false; }
  }
  return pending;
}

function completePendingTicket(pending: PendingTicket): void {
  if (!pending.persisted) return;
  const storage = sessionStorageOrUndefined();
  try {
    const stored = JSON.parse(storage?.getItem(PENDING_TICKET_KEY) ?? "null") as Partial<PendingTicket> | null;
    if (stored?.identity === pending.identity && stored.idempotencyKey === pending.idempotencyKey) {
      storage?.removeItem(PENDING_TICKET_KEY);
    }
  } catch {
    try { storage?.removeItem(PENDING_TICKET_KEY); } catch { /* Browser storage is optional. */ }
  }
}

async function ticketIdentity(input: TicketInput): Promise<string> {
  const serialized = JSON.stringify(input);
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    return `sha256:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return `memory:${serialized}`;
  }
}

function sessionStorageOrUndefined(): Storage | undefined {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(value);
}
