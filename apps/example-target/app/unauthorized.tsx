import Link from "next/link";

export default function UnauthorizedPage() {
  return <main>
    <h1>401 — Sign in required</h1>
    <p>The parts workspace is available to signed-in operators only.</p>
    <p><Link href="/login">Go to the sign-in page</Link></p>
  </main>;
}
