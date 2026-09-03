import React from "react";
import Link from "next/link";

/**
 * The console's primary navigation. It reflects the session so a signed-in
 * visitor sees a sign-out control instead of a sign-in link.
 */
export function ConsoleNavigation({ signedIn }: { signedIn: boolean }) {
  return <nav>
    <Link href="/workspace">Parts workspace</Link>{" \u00b7 "}
    {signedIn
      ? <form method="post" action="/api/auth/logout"><button type="submit">Sign out</button></form>
      : <Link href="/login">Sign in</Link>}
    {" \u00b7 "}
    <a href="/openapi.json">API description</a>
    {signedIn && <form method="get" action="/workspace">
      <label>Search parts <input aria-label="Search parts" name="q" /></label>
      <button type="submit">Search</button>
    </form>}
  </nav>;
}
