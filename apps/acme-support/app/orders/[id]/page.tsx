"use client";
import { FormEvent, useEffect, useState } from "react";

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const [title, setTitle] = useState(""); const [status, setStatus] = useState(""); const [tickets, setTickets] = useState<Array<{ ticketId: string; title: string }>>([]);
  useEffect(() => { void params.then(async ({ id }) => { const response = await fetch(`/api/tickets?orderId=${encodeURIComponent(id)}`); if (response.ok) setTickets(await response.json()); }); }, [params]);
  async function create(event: FormEvent) { event.preventDefault(); const { id } = await params; const response = await fetch("/api/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: id, title, priority: "high" }) }); setStatus(response.ok ? title : "Ticket failed"); if (response.ok) setTickets((current) => [...current, { ticketId: `local-${current.length}`, title }]); }
  return <main><h1>Order</h1><form onSubmit={create}><label>Ticket title <input value={title} onChange={(event) => setTitle(event.target.value)} /></label><button>Create ticket</button></form>{status && <p>{status}</p>}<section aria-label="Tickets"><h2>Tickets</h2><ul>{tickets.map((ticket) => <li key={ticket.ticketId}>{ticket.title}</li>)}</ul></section></main>;
}
