import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Page2WebMCP", description: "WebMCP capability compiler" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
