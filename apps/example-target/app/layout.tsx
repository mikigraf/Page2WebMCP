import type { Metadata } from "next";
import { HostedReleaseScript } from "./hosted-release-script";

/** Rendered per request so an installed release is picked up on restart, not at build time. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Beacon Parts Console",
  description: "Example Page2WebMCP target site running a hosted release",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body style={{ fontFamily: "system-ui", margin: "2rem", maxWidth: 960 }}><HostedReleaseScript />{children}</body></html>;
}
