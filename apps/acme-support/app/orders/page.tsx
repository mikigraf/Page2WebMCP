"use client";
import { FormEvent, useState } from "react";

type Order = { id: string; email: string; shipmentStatus: string };

export default function OrdersPage() {
  const [query, setQuery] = useState("ORD-4812");
  const [orders, setOrders] = useState<Order[]>([]);
  async function search(event: FormEvent) { event.preventDefault(); const response = await fetch(`/api/orders?q=${encodeURIComponent(query)}`); setOrders(response.ok ? await response.json() : []); }
  return <main><h1>Orders</h1><form onSubmit={search}><label>Search orders <input aria-label="Search orders" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button>Search</button></form><ul>{orders.map((order) => <li key={order.id}><a href={`/orders/${order.id}`}>{order.id}</a> — {order.shipmentStatus}</li>)}</ul></main>;
}
