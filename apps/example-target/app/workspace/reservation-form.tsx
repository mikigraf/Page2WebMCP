"use client";
import { FormEvent, useState } from "react";

type Reservation = { reservationId: string; sku: string; quantity: number; status: string; effectCount: number };
const REQUEST_DEADLINE_MS = 15_000;

export default function ReservationForm() {
  const [sku, setSku] = useState("PC-1180");
  const [quantity, setQuantity] = useState("1");
  const [orderReference, setOrderReference] = useState("SO-90001");
  const [status, setStatus] = useState("");
  const [reservation, setReservation] = useState<Reservation | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function reserve(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
    try {
      const input = { sku, quantity: Number(quantity), orderReference, confirmed: true };
      if (!window.confirm(`Reserve stock?\n\nPart: ${input.sku}\nQuantity: ${input.quantity}\nOrder: ${input.orderReference}`)) {
        setStatus("Reservation cancelled");
        return;
      }
      const idempotencyKey = crypto.randomUUID();
      const confirmation = await fetch("/api/confirmations", {
        method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName: "reserve_part_stock", input, idempotencyKey }),
      });
      if (!confirmation.ok) {
        setStatus("Reservation failed");
        return;
      }
      const { evidence } = await confirmation.json() as { evidence: string };
      const response = await fetch("/api/reservations", {
        method: "POST", signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-page2webmcp-confirmation": evidence,
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        setStatus("Reservation failed");
        return;
      }
      const created = await response.json() as Reservation;
      setReservation(created);
      setStatus(`Reserved ${created.sku} × ${created.quantity}`);
    } catch {
      setStatus("Reservation failed");
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }

  async function release() {
    if (!reservation || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/reservations/${encodeURIComponent(reservation.reservationId)}`, { method: "DELETE" });
      setStatus(response.ok ? `Released ${reservation.reservationId}` : "Release failed");
      if (response.ok) setReservation(undefined);
    } catch {
      setStatus("Release failed");
    } finally {
      setBusy(false);
    }
  }

  return <section aria-label="Reserve stock">
    <h2>Reserve stock</h2>
    <form onSubmit={reserve}>
      <label>Part <input aria-label="Part" value={sku} onChange={(event) => setSku(event.target.value)} /></label>
      <label>Quantity <input aria-label="Quantity" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
      <label>Order <input aria-label="Order" value={orderReference} onChange={(event) => setOrderReference(event.target.value)} /></label>
      <button disabled={busy}>Reserve</button>
    </form>
    {reservation && <button type="button" disabled={busy} onClick={release}>Release {reservation.reservationId}</button>}
    {status && <p>{status}</p>}
  </section>;
}
