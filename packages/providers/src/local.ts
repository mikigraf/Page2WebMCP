import { createHash, randomUUID } from "node:crypto";

export class ProviderError extends Error { constructor(readonly code: string) { super(code); } }
export type BrowserSession = { id: string; origin: string; expiresAt: number };
export class LocalBrowserProvider {
  #sessions = new Map<string, BrowserSession>();
  async start(origin: string): Promise<BrowserSession> { const value = { id: randomUUID(), origin, expiresAt: Date.now() + 600_000 }; this.#sessions.set(value.id, value); return value; }
  async get(id: string): Promise<BrowserSession> { const value = this.#sessions.get(id); if (!value) throw new ProviderError("SESSION_NOT_FOUND"); return value; }
  async destroy(id: string): Promise<void> { this.#sessions.delete(id); }
}
export class LocalArtifactStore {
  #items = new Map<string, { id: string; content: string; contentHash: string }>();
  publish(content: string, contentHash: string) { const id = createHash("sha256").update(contentHash).digest("hex"); const item = { id, content, contentHash }; this.#items.set(id, item); return item; }
  get(id: string) { const item = this.#items.get(id); if (!item) throw new ProviderError("ARTIFACT_NOT_FOUND"); return item; }
}
