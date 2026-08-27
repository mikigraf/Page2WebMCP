import type { Metadata } from "next";
export const metadata: Metadata = { title: "Page2WebMCP", description: "WebMCP capability compiler" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body style={{ fontFamily: "system-ui", maxWidth: 1080, margin: "2rem auto" }}>{children}</body></html>; }
