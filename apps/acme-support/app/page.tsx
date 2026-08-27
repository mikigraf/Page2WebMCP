import Link from "next/link";

export default function HomePage() {
  return <main><h1>Acme Support Console</h1><p>Authenticated support workflows for Page2WebMCP verification.</p><nav><Link href="/orders">Search orders</Link>{" · "}<Link href="/settings">Account settings</Link></nav></main>;
}
