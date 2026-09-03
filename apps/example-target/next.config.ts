import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Content-Security-Policy", value: "base-uri 'self'; frame-ancestors 'none'; object-src 'none'" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" }
];

const nextConfig: NextConfig = {
  // One persistent server process: the console's sessions and reservations
  // live in memory and must be coherent across pages and route handlers.
  output: "standalone",
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  experimental: { authInterrupts: true },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};
export default nextConfig;
