import { cookies } from "next/headers";
import { SESSION_COOKIE, partsConsole } from "./api/_runtime";
import { ConsoleNavigation } from "./console-navigation";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const store = await cookies();
  const signedIn = partsConsole().isAuthenticated(store.get(SESSION_COOKIE)?.value ?? "");
  return <main>
    <h1>Beacon Parts Console</h1>
    <p>Parts availability and reversible stock reservations for field service orders.</p>
    <ConsoleNavigation signedIn={signedIn} />
  </main>;
}
