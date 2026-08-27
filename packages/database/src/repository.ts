import { randomUUID } from "node:crypto";
export class RepositoryError extends Error { constructor(readonly code: "FORBIDDEN" | "NOT_FOUND") { super(code); } }
export type ProjectRecord = { id: string; organizationId: string; name: string };
export class InMemoryProjectRepository {
  #projects = new Map<string, ProjectRecord>();
  create(input: Omit<ProjectRecord, "id">): ProjectRecord { const value = { id: randomUUID(), ...input }; this.#projects.set(value.id, value); return value; }
  get(organizationId: string, id: string): ProjectRecord { const value = this.#projects.get(id); if (!value) throw new RepositoryError("NOT_FOUND"); if (value.organizationId !== organizationId) throw new RepositoryError("FORBIDDEN"); return value; }
}
