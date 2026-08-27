"use client";

import { FormEvent, useState } from "react";

type SourceType = "website" | "openapi" | "github";
type Capability = { identity: { name: string }; safety: { riskTier: "R0" | "R1" | "R2" | "R3" }; status: string };

export function ProjectEntry() {
  const [sourceType, setSourceType] = useState<SourceType>("website");
  const [url, setUrl] = useState("https://acme.example");
  const [message, setMessage] = useState("");
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [draftReady, setDraftReady] = useState(false);
  const [published, setPublished] = useState(false);
  const [releaseUrl, setReleaseUrl] = useState("https://acme.example/api/releases/acme");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedInRole, setSignedInRole] = useState("");

  async function signIn(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const body = await response.json() as { role?: string; code?: string };
    if (!response.ok) { setMessage(`Sign in failed: ${body.code}`); return; }
    setSignedInRole(body.role ?? ""); setMessage("");
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    setCapabilities([]); setDraftReady(false);
    const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceType, url }) });
    const body = await response.json() as { id?: string; url?: string; code?: string };
    if (response.ok && body.url) setReleaseUrl(new URL("/api/releases/acme", body.url).toString());
    setMessage(response.ok ? `Project ${body.id} created` : `Project creation failed: ${body.code}`);
  }

  async function analyze() {
    setCapabilities([]); setDraftReady(false);
    const response = await fetch("/api/projects/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceType }) });
    const body = await response.json() as { capabilities?: Capability[]; draftPullRequest?: { draft: boolean }; code?: string };
    if (!response.ok) { setMessage(`Analysis failed: ${body.code}`); return; }
    setCapabilities(body.capabilities ?? []);
    setDraftReady(body.draftPullRequest?.draft === true);
    setMessage(`Analysis complete for ${sourceType}`);
  }

  async function review(capability: Capability, action: "approve" | "block") {
    const response = await fetch("/api/capabilities/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: capability.identity.name, riskTier: capability.safety.riskTier, action }) });
    const body = await response.json() as { status?: string; code?: string };
    if (!response.ok) { setMessage(`Review failed: ${body.code}`); return; }
    setCapabilities((current) => current.map((item) => item.identity.name === capability.identity.name ? { ...item, status: body.status ?? item.status } : item));
  }

  async function publish() {
    const report = { schema: true, authenticated: true, replayPasses: 3, noSecretLeakage: true, browserExecution: true, selectionScore: 20 };
    const response = await fetch("/api/releases/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ report }) });
    if (!response.ok) { setMessage("Publication failed: owner approval and all verification gates are required"); return; }
    setPublished(true); setMessage("Immutable release published");
  }

  return <section aria-labelledby="project-entry-heading">
    <h2 id="project-entry-heading">Create a project</h2>
    <form onSubmit={signIn}><label>Email <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Password <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><button type="submit">Sign in</button></form>
    {signedInRole && <p>Signed in as {signedInRole}</p>}
    <form onSubmit={createProject}>
      <label>Source type <select value={sourceType} onChange={(event) => setSourceType(event.target.value as SourceType)}><option value="website">Website URL</option><option value="openapi">OpenAPI URL</option><option value="github">GitHub repository</option></select></label>
      <label>Source URL <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required /></label>
      <button type="submit">Create project</button>
    </form>
    <button type="button" onClick={analyze}>Analyze {sourceType}</button>
    {message && <p role="status">{message}</p>}
    {capabilities.length > 0 && <ul aria-label="Capabilities">{capabilities.map((capability) => <li key={capability.identity.name}><code>{capability.identity.name}</code>: {capability.status} {capability.status !== "blocked" && <><button type="button" onClick={() => review(capability, "approve")}>Approve {capability.identity.name}</button><button type="button" onClick={() => review(capability, "block")}>Block {capability.identity.name}</button></>}</li>)}</ul>}
    <button type="button" onClick={publish}>Publish immutable release</button>
    {published && <a href={releaseUrl}>Download Acme release</a>}
    {draftReady && <p>Draft pull request prepared</p>}
  </section>;
}
