import { cookies } from "next/headers";
import { unauthorized } from "next/navigation";
import Link from "next/link";
import { SESSION_COOKIE, partsConsole } from "../api/_runtime";
import { resolveWorkspaceView } from "../../src/workspace-view";
import ReservationForm from "./reservation-form";

export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const store = await cookies();
  const view = resolveWorkspaceView(partsConsole(), store.get(SESSION_COOKIE)?.value ?? "");
  if (!view) unauthorized();
  return <main>
    <h1>{view.title}</h1>
    <p><Link href="/">Back to the console home</Link></p>
    <section aria-label="Parts">
      <h2>Parts</h2>
      <ul>{view.parts.map((part) => <li key={part.sku}>{part.sku} — {part.name} — {part.available} available</li>)}</ul>
    </section>
    <section aria-label="Reservations">
      <h2>Reservations</h2>
      <ul>{view.reservations.map((reservation) => <li key={reservation.reservationId}>
        {reservation.reservationId} — {reservation.sku} × {reservation.quantity} — {reservation.status}
      </li>)}</ul>
    </section>
    <ReservationForm />
  </main>;
}
