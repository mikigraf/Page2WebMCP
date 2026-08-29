import { z } from "zod";
import { validateTargetUrl } from "../../../packages/security/src/security.ts";

export const ProjectInputSchema = z.object({
  sourceType: z.enum(["website", "openapi", "github"]),
  url: z.string().url().max(2_048)
}).strict();

export type ProjectInput = z.infer<typeof ProjectInputSchema>;

export function normalizeProjectInput(input: ProjectInput):
  | { ok: true; value: ProjectInput & { name: string } }
  | { ok: false; code: string } {
  if (process.env.PAGE2WEBMCP_PROVIDER_MODE === "live") {
    return { ok: false, code: "LIVE_PROVIDER_UNSUPPORTED" };
  }
  const target = validateTargetUrl(input.url);
  if (!target.ok) return { ok: false, code: target.code ?? "INVALID_URL" };

  const url = new URL(input.url);
  url.hash = "";
  const fixtureOrigin = new URL(process.env.PAGE2WEBMCP_FIXTURE_APP_URL ?? "https://acme.example");
  const fixtureGithub = new URL(process.env.PAGE2WEBMCP_FIXTURE_GITHUB_URL ?? "https://github.com/acme/support");

  if (input.sourceType === "github") {
    if (url.hostname !== "github.com") return { ok: false, code: "GITHUB_URL_REQUIRED" };
    if (canonicalUrl(url) !== canonicalUrl(fixtureGithub)) return { ok: false, code: "FIXTURE_SOURCE_REQUIRED" };
  } else if (input.sourceType === "website") {
    if (url.origin !== fixtureOrigin.origin || (url.pathname !== "/" && url.pathname !== "")) {
      return { ok: false, code: "FIXTURE_SOURCE_REQUIRED" };
    }
    url.pathname = "/";
    url.search = "";
  } else {
    if (url.origin !== fixtureOrigin.origin || url.pathname !== "/openapi.json" || url.search) {
      return { ok: false, code: "FIXTURE_SOURCE_REQUIRED" };
    }
  }

  return {
    ok: true,
    value: {
      sourceType: input.sourceType,
      url: canonicalUrl(url),
      name: input.sourceType === "github" ? "Acme Support source" : "Acme Support"
    }
  };
}

function canonicalUrl(url: URL): string {
  return url.toString().replace(/\/$/, url.pathname === "/" ? "/" : "");
}
