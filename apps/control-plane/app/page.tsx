import { ProjectEntry } from "./project-entry";

export default async function HomePage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const rawAuthState = (await searchParams).auth;
  const authState = rawAuthState === "verified" || rawAuthState === "recovery" ? rawAuthState : undefined;
  return <main><h1>Page2WebMCP</h1><p>Turn a supported public website, OpenAPI document, or GitHub repository into reviewed WebMCP tools.</p><ProjectEntry authState={authState} /></main>;
}
