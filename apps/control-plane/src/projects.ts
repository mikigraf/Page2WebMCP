import { z } from "zod";
import { validateTargetUrl } from "../../../packages/security/src/security";

export const ProjectInputSchema = z.object({
  sourceType: z.enum(["website", "openapi", "github"]),
  url: z.string().url()
}).strict();

export type Project = {
  id: string;
  sourceType: "website" | "openapi" | "github";
  url: string;
  status: "created";
};

const projects: Project[] = [];

export function createProject(input: z.infer<typeof ProjectInputSchema>): Project | { code: string } {
  const target = validateTargetUrl(input.url);
  if (!target.ok) return { code: target.code! };
  if (input.sourceType === "github" && new URL(input.url).hostname !== "github.com") return { code: "GITHUB_URL_REQUIRED" };
  const project = { id: `project-${projects.length + 1}`, ...input, status: "created" as const };
  projects.push(project);
  return project;
}

export function listProjects(): Project[] { return [...projects]; }
export function resetProjectsForTest(): void { projects.splice(0); }
