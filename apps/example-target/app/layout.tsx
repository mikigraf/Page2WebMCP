import type { Metadata } from "next";
import { cookies } from "next/headers";
import { HostedReleaseScript } from "./hosted-release-script";
import { RequestTokenMeta } from "./request-token-meta";
import { SESSION_COOKIE, partsConsole } from "./api/_runtime";

/** Rendered per request so an installed release is picked up on restart, not at build time. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Beacon Parts Console",
  description: "Example Page2WebMCP target site running a hosted release",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const store = await cookies();
  const requestToken = partsConsole().requestToken(store.get(SESSION_COOKIE)?.value ?? "");
  return <html lang="en">
    <head><RequestTokenMeta token={requestToken} /></head>
    <body style={{ fontFamily: "system-ui", margin: "2rem", maxWidth: 960 }}>
      <HostedReleaseScript />{children}
    </body>
  </html>;
}
