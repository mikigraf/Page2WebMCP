import type { Metadata } from "next";
import { WebMCPRegistration } from "./webmcp-registration";

export const metadata: Metadata = { title: "Acme Support Console", description: "Page2WebMCP fixture" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body style={{ fontFamily: "system-ui", margin: "2rem", maxWidth: 960 }}><WebMCPRegistration />{children}</body></html>;
}
