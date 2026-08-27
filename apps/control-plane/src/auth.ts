export type Role = "owner" | "editor" | "viewer";

const credentials: Record<string, { password: string; role: Role }> = {
  "owner@example.test": { password: "fixture-password", role: "owner" },
  "editor@example.test": { password: "fixture-password", role: "editor" }
};

export function authenticate(email: string, password: string): Role | undefined {
  const account = credentials[email];
  return account?.password === password ? account.role : undefined;
}

export function roleFromRequest(request: Request): Role | undefined {
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("page2webmcp_role="))?.split("=")[1];
  return value === "owner" || value === "editor" || value === "viewer" ? value : undefined;
}
