import * as ts from "typescript";

export type SourceAnalysis = { createTicket: { authorization: "source_confirmed" | "unknown"; route?: string } };

function hasCall(source: string, predicate: (expression: ts.Expression) => boolean): boolean {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && predicate(node.expression)) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function callsNamed(source: string, name: string): boolean {
  return hasCall(source, (expression) => ts.isIdentifier(expression) && expression.text === name || ts.isPropertyAccessExpression(expression) && expression.name.text === name);
}

function readsCookie(source: string): boolean {
  return hasCall(source, (expression) => ts.isPropertyAccessExpression(expression)
    && expression.name.text === "get"
    && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === "cookies");
}

export function analyzeSource(files: Record<string, string>): SourceAnalysis {
  const route = Object.entries(files).find(([path, content]) => /route\.ts$/.test(path) && callsNamed(content, "createTicket") && callsNamed(content, "session"));
  const auth = Object.values(files).some(readsCookie);
  return { createTicket: { authorization: route && auth ? "source_confirmed" : "unknown", route: route?.[0] } };
}
export function generateHardeningChange(analysis: SourceAnalysis): string[] {
  if (analysis.createTicket.authorization !== "source_confirmed") throw new Error("AUTHORIZATION_UNCONFIRMED");
  return ["app/_page2webmcp/register.generated.ts", "tests/page2webmcp/tools.test.ts", "docs/page2webmcp-security.md"];
}
