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
  const target = validateTargetUrl(input.url);
  if (!target.ok) return { ok: false, code: target.code ?? "INVALID_URL" };

  const url = new URL(input.url);
  if (url.hash) return { ok: false, code: "SOURCE_FRAGMENT_FORBIDDEN" };
  if (url.search) return { ok: false, code: "SOURCE_QUERY_FORBIDDEN" };

  if (input.sourceType === "github") {
    if (url.hostname !== "github.com") return { ok: false, code: "GITHUB_URL_REQUIRED" };
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) return { ok: false, code: "GITHUB_REPOSITORY_URL_REQUIRED" };
    const [owner, rawRepository] = segments;
    const repository = rawRepository?.replace(/\.git$/i, "");
    if (!owner || !repository || !/^[A-Za-z0-9-]{1,100}$/.test(owner)
      || !/^[A-Za-z0-9._-]{1,100}$/.test(repository) || repository.startsWith(".")) {
      return { ok: false, code: "GITHUB_REPOSITORY_URL_REQUIRED" };
    }
    url.pathname = `/${owner}/${repository}`;
    return {
      ok: true,
      value: { sourceType: input.sourceType, url: canonicalUrl(url), name: `${owner}/${repository}` }
    };
  }

  return {
    ok: true,
    value: {
      sourceType: input.sourceType,
      url: canonicalUrl(url),
      name: input.sourceType === "openapi" ? `${url.hostname} API` : url.hostname
    }
  };
}

function canonicalUrl(url: URL): string {
  return url.toString();
}
