"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        setStatus("Sign-in failed");
        return;
      }
      setPassword("");
      setStatus("Signed in");
      router.push("/workspace");
    } catch {
      setStatus("Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return <main>
    <h1>Sign in</h1>
    <p>Operators sign in to reach the parts workspace.</p>
    <form onSubmit={submit}>
      <label>Email <input aria-label="Email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Password <input aria-label="Password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button disabled={busy}>Sign in</button>
    </form>
    {status && <p role="status">{status}</p>}
  </main>;
}
