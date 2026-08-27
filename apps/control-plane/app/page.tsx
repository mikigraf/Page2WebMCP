import Link from "next/link";
import { ProjectEntry } from "./project-entry";

export default function HomePage() { return <main><h1>Page2WebMCP</h1><p>Paste your website or OpenAPI URL to generate safe, imperative WebMCP tools.</p><ProjectEntry /><p><Link href="/projects/demo">Open Acme Support demo project</Link></p></main>; }
