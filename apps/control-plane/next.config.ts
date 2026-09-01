import type { NextConfig } from "next";
import { configuredDeploymentIdentity } from "./src/deployment-identity.ts";

const securityHeaders = [
  { key: "Content-Security-Policy", value: "base-uri 'self'; frame-ancestors 'none'; object-src 'none'" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" }
];

const configuredReleaseId = process.env.PAGE2WEBMCP_PRODUCTION_LIVE_BUILD === "true"
  ? configuredDeploymentIdentity(process.env).applicationReleaseId
  : process.env.PAGE2WEBMCP_APPLICATION_RELEASE_ID;

if (configuredReleaseId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(configuredReleaseId)) {
  throw new Error("DEPLOYMENT_IDENTITY_CONFIGURATION_REQUIRED");
}

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  ...(configuredReleaseId
    ? { deploymentId: configuredReleaseId }
    : {}),
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};
export default nextConfig;
