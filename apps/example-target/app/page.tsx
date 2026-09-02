import Link from "next/link";

export default function HomePage() {
  return <main>
    <h1>Beacon Parts Console</h1>
    <p>Parts availability and reversible stock reservations for field service orders.</p>
    <nav>
      <Link href="/workspace">Parts workspace</Link>{" · "}
      <Link href="/login">Sign in</Link>{" · "}
      <a href="/openapi.json">API description</a>
    </nav>
  </main>;
}
