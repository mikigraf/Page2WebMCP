import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import {
  CapabilityPlanSchema,
  canonicalizeCapabilityPlans,
  type CapabilityPlan,
  type JsonSchema,
  type ObjectJsonSchema,
} from "../../capability-ir/src/plan.ts";
import { compileWebMcpRelease, type CompiledRelease } from "../../compiler/src/compiler.ts";
import { gitHubSourceSnapshotReference, type GitHubSourceSnapshot } from "../../providers/src/github.ts";

const MAX_SOURCE_FILES = 256;
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_EVIDENCE_BYTES = 64 * 1_024;
const routePattern = /^(?:src\/)?app\/(.+\/)route\.(?:ts|tsx)$/;
const methodNames = new Set(["GET", "POST"]);

export type GitHubSourceDiagnosticCode =
  | "AUTHORIZATION_UNCONFIRMED"
  | "CANONICAL_PLAN_UNSUPPORTED"
  | "REQUEST_VALIDATION_UNCONFIRMED"
  | "RESPONSE_VALIDATION_UNCONFIRMED"
  | "SERVICE_LINKAGE_UNCONFIRMED"
  | "UNSUPPORTED_REPOSITORY"
  | "UNSUPPORTED_ROUTE"
  | "UNSUPPORTED_SCHEMA";

export type GitHubSourceDiagnostic = Readonly<{
  code: GitHubSourceDiagnosticCode;
  operationKey: string;
}>;

export type GitHubSourceAnalysis = Readonly<{
  plans: CapabilityPlan[];
  diagnostics: GitHubSourceDiagnostic[];
  evidence: Readonly<{ source: "github"; content: string; reference: string }>;
}>;

export type GeneratedSourceNativeFile = Readonly<{
  path: string;
  content: string;
  contentHash: string;
}>;

export type SourceNativeChange = Readonly<{
  version: 1;
  baseCommitSha: string;
  patchDigest: string;
  files: readonly GeneratedSourceNativeFile[];
  release: CompiledRelease;
}>;

type ImportBinding = Readonly<{ imported: string; module: string; resolvedPath?: string }>;
type RouteCandidate = Readonly<{
  file: GitHubSourceSnapshot["files"][number];
  pathTemplate: string;
  method: "GET" | "POST";
  sourceFile: ts.SourceFile;
  functionNode: ts.FunctionLikeDeclaration;
  imports: ReadonlyMap<string, ImportBinding>;
}>;

type RouteFact = Readonly<{
  operationKey: string;
  file: string;
  fileDigest: string;
  method: "GET" | "POST";
  pathTemplate: string;
  authorization: "source_confirmed" | "unknown";
  validation: "zod_parse" | "unknown";
  responseValidation: "zod_parse" | "unknown";
  requestSchemaDigest?: string;
  responseSchemaDigest?: string;
  services: readonly string[];
  forms: readonly string[];
  idempotency: "verified_header" | "none";
}>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertExactOrigin(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("GITHUB_TARGET_ORIGIN_INVALID"); }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== value || url.username || url.password || url.hash || (url.protocol !== "https:" && !localHttp)) {
    throw new Error("GITHUB_TARGET_ORIGIN_INVALID");
  }
}

function assertSnapshot(snapshot: GitHubSourceSnapshot): void {
  if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.installationId) || snapshot.installationId <= 0
    || !Number.isSafeInteger(snapshot.repositoryId) || snapshot.repositoryId <= 0
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(snapshot.owner)
    || !/^[A-Za-z0-9._-]{1,100}$/.test(snapshot.repository)
    || !/^refs\/(?:heads|tags)\//.test(snapshot.requestedRef)
    || !/^[a-f0-9]{40}$/.test(snapshot.commitSha)
    || !/^urn:sha256:[a-f0-9]{64}$/.test(snapshot.reference)
    || !Array.isArray(snapshot.files) || snapshot.files.length > MAX_SOURCE_FILES
    || !Number.isSafeInteger(snapshot.totalBytes) || snapshot.totalBytes < 0 || snapshot.totalBytes > MAX_SOURCE_BYTES) {
    throw new Error("GITHUB_SNAPSHOT_INVALID");
  }
  let totalBytes = 0;
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string"
      || paths.has(file.path) || file.byteLength !== Buffer.byteLength(file.content, "utf8")
      || file.contentHash !== sha256(file.content)) throw new Error("GITHUB_SNAPSHOT_INVALID");
    paths.add(file.path);
    totalBytes += file.byteLength;
  }
  if (totalBytes !== snapshot.totalBytes || snapshot.reference !== gitHubSourceSnapshotReference(snapshot)) {
    throw new Error("GITHUB_SNAPSHOT_INVALID");
  }
}

function routePath(filePath: string): string | undefined {
  const match = routePattern.exec(filePath);
  if (!match) return undefined;
  const parts = match[1]!.slice(0, -1).split("/")
    .filter((part) => !/^\(.+\)$/.test(part));
  if (parts.some((part) => part.startsWith("@") || /^\[\.\.\..+\]$/.test(part) || /^\[\[/.test(part))) return undefined;
  const mapped = parts.map((part) => {
    const dynamic = /^\[([A-Za-z][A-Za-z0-9_]*)\]$/.exec(part);
    return dynamic ? `{${dynamic[1]}}` : part;
  });
  return `/${mapped.join("/")}`;
}

function resolveImport(
  importer: string,
  moduleSpecifier: string,
  filePaths: ReadonlySet<string>,
): string | undefined {
  let base: string;
  if (moduleSpecifier.startsWith("@/")) base = moduleSpecifier.slice(2);
  else if (moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../")) {
    base = posix.normalize(posix.join(posix.dirname(importer), moduleSpecifier));
  }
  else return undefined;
  if (base.startsWith("../") || base.startsWith("/")) return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (filePaths.has(candidate)) return candidate;
  }
  return undefined;
}

function importBindings(sourceFile: ts.SourceFile, filePaths: ReadonlySet<string>): ReadonlyMap<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const resolvedPath = resolveImport(sourceFile.fileName, moduleSpecifier, filePaths);
    const clause = statement.importClause;
    if (clause?.name) bindings.set(clause.name.text, { imported: "default", module: moduleSpecifier, resolvedPath });
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const specifier of clause.namedBindings.elements) {
        bindings.set(specifier.name.text, {
          imported: specifier.propertyName?.text ?? specifier.name.text,
          module: moduleSpecifier,
          resolvedPath,
        });
      }
    }
  }
  return bindings;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function routeFunctions(sourceFile: ts.SourceFile): Array<Readonly<{ method: "GET" | "POST"; node: ts.FunctionLikeDeclaration }>> {
  const functions: Array<Readonly<{ method: "GET" | "POST"; node: ts.FunctionLikeDeclaration }>> = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)
      && methodNames.has(statement.name.text) && statement.body) {
      functions.push({ method: statement.name.text as "GET" | "POST", node: statement });
      continue;
    }
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !methodNames.has(declaration.name.text) || !declaration.initializer
        || !ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) continue;
      functions.push({ method: declaration.name.text as "GET" | "POST", node: declaration.initializer });
    }
  }
  return functions;
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  node.forEachChild((child) => visit(child, visitor));
}

function calledIdentifiers(node: ts.Node): Set<string> {
  const names = new Set<string>();
  visit(node, (candidate) => {
    if (!ts.isCallExpression(candidate)) return;
    if (ts.isIdentifier(candidate.expression)) names.add(candidate.expression.text);
    else if (ts.isPropertyAccessExpression(candidate.expression)) names.add(candidate.expression.name.text);
  });
  return names;
}

function containsRequestRead(node: ts.Node, kind: "json" | "formData"): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (ts.isCallExpression(candidate) && ts.isPropertyAccessExpression(candidate.expression)
      && candidate.expression.name.text === kind) found = true;
  });
  return found;
}

function variableInitializers(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const result = new Map<string, ts.Expression>();
  const ambiguous = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const node of statement.declarationList.declarations) {
      if (!ts.isIdentifier(node.name) || !node.initializer) continue;
      if (result.has(node.name.text)) {
        result.delete(node.name.text);
        ambiguous.add(node.name.text);
      } else if (!ambiguous.has(node.name.text)) result.set(node.name.text, node.initializer);
    }
  }
  return result;
}

type ParsedSchema = Readonly<{ schema: JsonSchema; optional: boolean }>;

function literalNumber(node: ts.Expression | undefined): number | undefined {
  if (!node || !ts.isNumericLiteral(node)) return undefined;
  const value = Number(node.text);
  return Number.isFinite(value) ? value : undefined;
}

function zodChain(expression: ts.Expression): Readonly<{ base: ts.CallExpression; calls: Array<Readonly<{ name: string; args: readonly ts.Expression[] }>> }> | undefined {
  const calls: Array<Readonly<{ name: string; args: readonly ts.Expression[] }>> = [];
  let current: ts.Expression = expression;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const target = current.expression.expression;
    const name = current.expression.name.text;
    if (ts.isIdentifier(target) && target.text === "z") return { base: current, calls: [{ name, args: current.arguments }, ...calls] };
    calls.unshift({ name, args: current.arguments });
    current = target;
  }
  return undefined;
}

function parseZodSchema(expression: ts.Expression, depth = 0): ParsedSchema | undefined {
  if (depth > 8) return undefined;
  const chain = zodChain(expression);
  if (!chain || chain.calls.length === 0) return undefined;
  const [base, ...modifiers] = chain.calls;
  let schema: JsonSchema;
  if (base!.name === "string") schema = { type: "string" };
  else if (base!.name === "boolean") schema = { type: "boolean" };
  else if (base!.name === "number") schema = { type: "number" };
  else if (base!.name === "enum") {
    const values = base!.args[0];
    if (!values || !ts.isArrayLiteralExpression(values) || values.elements.length === 0
      || values.elements.some((item) => !ts.isStringLiteral(item))) return undefined;
    schema = { type: "string", enum: values.elements.map((item) => (item as ts.StringLiteral).text).sort(compareStrings) };
  } else if (base!.name === "array") {
    const item = base!.args[0];
    if (!item) return undefined;
    const parsed = parseZodSchema(item, depth + 1);
    if (!parsed || parsed.optional) return undefined;
    schema = { type: "array", items: parsed.schema };
  } else if (base!.name === "object") {
    const object = base!.args[0];
    if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
      if (!name || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) return undefined;
      if (["__proto__", "constructor", "prototype"].includes(name)) return undefined;
      const parsed = parseZodSchema(property.initializer, depth + 1);
      if (!parsed) return undefined;
      properties[name] = parsed.schema;
      if (!parsed.optional) required.push(name);
    }
    schema = {
      type: "object",
      properties: Object.fromEntries(Object.entries(properties).sort(([left], [right]) => compareStrings(left, right))),
      required: required.sort(compareStrings),
      additionalProperties: false,
    };
  } else return undefined;
  let optional = false;
  for (const modifier of modifiers) {
    if (modifier.name === "optional" && modifier.args.length === 0) optional = true;
    else if (modifier.name === "min" || modifier.name === "max") {
      const value = literalNumber(modifier.args[0]);
      if (value === undefined || value < 0) return undefined;
      if (schema.type === "string") schema = { ...schema, [modifier.name === "min" ? "minLength" : "maxLength"]: value };
      else if (schema.type === "array") schema = { ...schema, [modifier.name === "min" ? "minItems" : "maxItems"]: value };
      else if (schema.type === "number" || schema.type === "integer") schema = { ...schema, [modifier.name === "min" ? "minimum" : "maximum"]: value };
      else return undefined;
    } else if (modifier.name === "int" && schema.type === "number" && modifier.args.length === 0) {
      schema = { type: "integer", ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }), ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }) };
    } else return undefined;
  }
  return { schema, optional };
}

function schemaUsedForRequest(
  functionNode: ts.FunctionLikeDeclaration,
  declarations: ReadonlyMap<string, ts.Expression>,
): ObjectJsonSchema | undefined {
  let schema: ObjectJsonSchema | undefined;
  visit(functionNode, (node) => {
    if (schema || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || node.expression.name.text !== "parse" || node.arguments.length !== 1
      || !containsRequestRead(node.arguments[0]!, "json") && !containsRequestRead(node.arguments[0]!, "formData")) return;
    const receiver = node.expression.expression;
    if (!ts.isIdentifier(receiver)) return;
    const initializer = declarations.get(receiver.text);
    if (!initializer) return;
    const parsed = parseZodSchema(initializer);
    if (parsed?.schema.type === "object" && !parsed.optional) schema = parsed.schema;
  });
  return schema;
}

function isWithinRequestParse(node: ts.CallExpression): boolean {
  return node.arguments.some((argument) => containsRequestRead(argument, "json") || containsRequestRead(argument, "formData"));
}

function schemaUsedForResponse(
  functionNode: ts.FunctionLikeDeclaration,
  declarations: ReadonlyMap<string, ts.Expression>,
): JsonSchema | undefined {
  let schema: JsonSchema | undefined;
  visit(functionNode, (responseCall) => {
    if (schema || !ts.isCallExpression(responseCall) || !ts.isPropertyAccessExpression(responseCall.expression)
      || responseCall.expression.name.text !== "json" || responseCall.arguments.length === 0) return;
    visit(responseCall.arguments[0]!, (node) => {
      if (schema || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
        || node.expression.name.text !== "parse" || isWithinRequestParse(node)) return;
      const receiver = node.expression.expression;
      if (!ts.isIdentifier(receiver)) return;
      const initializer = declarations.get(receiver.text);
      if (!initializer) return;
      const parsed = parseZodSchema(initializer);
      if (parsed && !parsed.optional) schema = parsed.schema;
    });
  });
  return schema;
}

function exportedImplementationFunction(sourceFile: ts.SourceFile, imported: string): ts.FunctionLikeDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body && hasExportModifier(statement)
      && (statement.name?.text === imported || imported === "default"
        && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword))) return statement;
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== imported || !declaration.initializer
        || !ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) continue;
      return declaration.initializer;
    }
  }
  return undefined;
}

function responseStatus(functionNode: ts.FunctionLikeDeclaration): number {
  let status = 200;
  visit(functionNode, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || node.expression.name.text !== "json" || node.arguments.length < 2) return;
    const options = node.arguments[1];
    if (!options || !ts.isObjectLiteralExpression(options)) return;
    const property = options.properties.find((candidate) => ts.isPropertyAssignment(candidate)
      && (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) && candidate.name.text === "status");
    if (property && ts.isPropertyAssignment(property)) {
      const value = literalNumber(property.initializer);
      if (value !== undefined) status = value;
    }
  });
  return status;
}

function authIsConfirmed(
  candidate: RouteCandidate,
  files: ReadonlyMap<string, GitHubSourceSnapshot["files"][number]>,
): boolean {
  const called = calledIdentifiers(candidate.functionNode);
  for (const [local, binding] of candidate.imports) {
    if (!called.has(local) || !binding.resolvedPath || !/(?:^|[/_.-])(?:auth|session|identity)(?:[/_.-]|$)/i.test(binding.module)) continue;
    const implementation = files.get(binding.resolvedPath);
    if (!implementation) continue;
    const source = ts.createSourceFile(binding.resolvedPath, implementation.content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const authFunction = exportedImplementationFunction(source, binding.imported);
    if (!authFunction) continue;
    let sessionRead = false;
    let rejectsMissingSession = false;
    visit(authFunction, (node) => {
      if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && ["cookies", "auth", "getUser", "getSession"].includes(node.expression.text)
        || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get"
          && node.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text.toLowerCase() === "cookie"))) sessionRead = true;
      if (ts.isThrowStatement(node)) rejectsMissingSession = true;
    });
    if (sessionRead && rejectsMissingSession) return true;
  }
  return false;
}

function verifiedIdempotency(candidate: RouteCandidate, files: ReadonlyMap<string, GitHubSourceSnapshot["files"][number]>): boolean {
  let readsHeader = false;
  visit(candidate.functionNode, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get"
      && node.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text.toLowerCase() === "idempotency-key")) readsHeader = true;
  });
  if (!readsHeader) return false;
  const called = calledIdentifiers(candidate.functionNode);
  return [...candidate.imports].some(([local, binding]) => called.has(local) && Boolean(binding.resolvedPath)
    && /(?:^|[/_.-])idempotency(?:[/_.-]|$)/i.test(binding.module)
    && files.has(binding.resolvedPath!));
}

function linkedServices(
  candidate: RouteCandidate,
  files: ReadonlyMap<string, GitHubSourceSnapshot["files"][number]>,
): string[] {
  const called = calledIdentifiers(candidate.functionNode);
  return [...candidate.imports]
    .filter(([local, binding]) => called.has(local) && Boolean(binding.resolvedPath)
      && !/(?:^|[/_.-])(?:auth|session|identity|idempotency)(?:[/_.-]|$)/i.test(binding.module)
      && binding.module !== "zod"
      && Boolean(binding.resolvedPath && files.get(binding.resolvedPath))
      && Boolean(binding.resolvedPath && exportedImplementationFunction(ts.createSourceFile(
        binding.resolvedPath,
        files.get(binding.resolvedPath)!.content,
        ts.ScriptTarget.ES2022,
        true,
        binding.resolvedPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ), binding.imported)))
    .map(([local]) => local)
    .sort(compareStrings);
}

function linkedForms(snapshot: GitHubSourceSnapshot, pathTemplate: string): string[] {
  const linked = new Set<string>();
  for (const file of snapshot.files) {
    if (!/(?:^|\/)page\.tsx$/.test(file.path)) continue;
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    visit(source, (node) => {
      if (!ts.isJsxOpeningElement(node) || node.tagName.getText(source) !== "form") return;
      const attributes = new Map<string, string>();
      for (const property of node.attributes.properties) {
        if (!ts.isJsxAttribute(property) || !property.initializer || !ts.isStringLiteral(property.initializer)) continue;
        attributes.set(property.name.getText(source), property.initializer.text);
      }
      if (attributes.get("action") === pathTemplate && (attributes.get("method") ?? "get").toLowerCase() === "post") linked.add(file.path);
    });
  }
  return [...linked].sort(compareStrings);
}

function toolName(method: string, pathTemplate: string): string {
  const value = `${method.toLowerCase()}_${pathTemplate.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_")}`
    .replace(/_+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return value.slice(0, 64).replace(/_+$/g, "") || "source_route";
}

function titleFor(method: string, pathTemplate: string): string {
  const words = toolName(method, pathTemplate).split("_").map((word) => word[0]!.toUpperCase() + word.slice(1));
  return words.join(" ").slice(0, 120);
}

function buildPlan(
  candidate: RouteCandidate,
  requestSchema: ObjectJsonSchema,
  outputSchema: JsonSchema,
  evidenceReference: string,
  targetOrigin: string,
  idempotencyVerified: boolean,
): CapabilityPlan {
  const mutation = candidate.method === "POST";
  const required = new Set(requestSchema.required);
  const fields = Object.keys(requestSchema.properties).sort(compareStrings);
  const pathFields = [...candidate.pathTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
  const payloadFields = fields.filter((field) => !pathFields.includes(field));
  const plan: CapabilityPlan = {
    version: 1,
    targetOrigin,
    tool: {
      name: toolName(candidate.method, candidate.pathTemplate),
      title: titleFor(candidate.method, candidate.pathTemplate),
      description: `${mutation ? "Submit" : "Read"} the reviewed ${candidate.pathTemplate} application route.`,
    },
    schemas: { input: requestSchema, output: outputSchema },
    annotations: { readOnly: !mutation, untrusted: true },
    authentication: { mode: mutation ? "same_origin_cookie" : "public", requiredScopes: [] },
    effects: mutation ? {
      kind: "mutation", riskTier: "R2", reversible: false,
      summary: `Submits one request to ${candidate.pathTemplate}.`, confirmation: "always",
    } : {
      kind: "read", riskTier: "R0", reversible: true,
      summary: `Reads ${candidate.pathTemplate}.`, confirmation: "none",
    },
    idempotency: mutation && idempotencyVerified ? {
      strategy: "header", headerName: "idempotency-key", verified: true, retry: "safe_once",
    } : { strategy: "none", verified: false, retry: "none" },
    request: {
      adapter: "json_api",
      method: candidate.method,
      pathTemplate: candidate.pathTemplate,
      path: Object.fromEntries(pathFields.map((field) => [field, field])),
      query: mutation ? {} : Object.fromEntries(payloadFields.map((field) => [field, field])),
      body: mutation ? Object.fromEntries(payloadFields.map((field) => [field, field])) : {},
      ...(payloadFields.every((field) => required.has(field)) ? {} : { optional: payloadFields.filter((field) => !required.has(field)) }),
    },
    response: {
      adapter: "json_api",
      contentTypes: ["application/json"],
      projection: { kind: "identity" },
      errorMappings: {
        "400": "VALIDATION_FAILED", "401": "AUTHENTICATION_REQUIRED", "403": "FORBIDDEN",
        "409": "STALE_TARGET", "429": "RATE_LIMITED", default: "TARGET_ERROR",
      },
    },
    success: {
      adapter: "json_api",
      statusCodes: [responseStatus(candidate.functionNode)],
      requiredOutputFields: outputSchema.type === "object" ? [...outputSchema.required].sort(compareStrings) : [],
    },
    evidence: [{ source: "github", reference: evidenceReference }],
  };
  return CapabilityPlanSchema.parse(plan);
}

function candidateFacts(
  candidates: readonly RouteCandidate[],
  snapshot: GitHubSourceSnapshot,
): ReadonlyArray<Readonly<{
  candidate: RouteCandidate;
  fact: RouteFact;
  requestSchema?: ObjectJsonSchema;
  outputSchema?: JsonSchema;
}>> {
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  return candidates.map((candidate) => {
    const declarations = variableInitializers(candidate.sourceFile);
    const requestSchema = schemaUsedForRequest(candidate.functionNode, declarations);
    const outputSchema = schemaUsedForResponse(candidate.functionNode, declarations);
    const authorization = candidate.method === "GET" || authIsConfirmed(candidate, files) ? "source_confirmed" : "unknown";
    const services = linkedServices(candidate, files);
    const idempotency = verifiedIdempotency(candidate, files) ? "verified_header" : "none";
    const fact: RouteFact = {
      operationKey: `${candidate.method} ${candidate.pathTemplate}`,
      file: candidate.file.path,
      fileDigest: candidate.file.contentHash,
      method: candidate.method,
      pathTemplate: candidate.pathTemplate,
      authorization,
      validation: requestSchema ? "zod_parse" : "unknown",
      responseValidation: outputSchema ? "zod_parse" : "unknown",
      ...(requestSchema ? { requestSchemaDigest: sha256(canonicalJson(requestSchema)) } : {}),
      ...(outputSchema ? { responseSchemaDigest: sha256(canonicalJson(outputSchema)) } : {}),
      services,
      forms: linkedForms(snapshot, candidate.pathTemplate),
      idempotency,
    };
    return { candidate, fact, requestSchema, outputSchema };
  });
}

export function analyzeGitHubSourceSnapshot(
  snapshot: GitHubSourceSnapshot,
  options: Readonly<{ targetOrigin: string }>,
): GitHubSourceAnalysis {
  assertSnapshot(snapshot);
  assertExactOrigin(options.targetOrigin);
  const filePaths = new Set(snapshot.files.map(({ path }) => path));
  const candidates: RouteCandidate[] = [];
  const routeKeys = new Set<string>();
  for (const file of [...snapshot.files].sort((left, right) => compareStrings(left.path, right.path))) {
    const pathTemplate = routePath(file.path);
    if (!routePattern.test(file.path)) continue;
    if (!pathTemplate) continue;
    const sourceFile = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ES2022, true,
      file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const imports = importBindings(sourceFile, filePaths);
    for (const routeFunction of routeFunctions(sourceFile)) {
      const key = `${routeFunction.method} ${pathTemplate}`;
      if (routeKeys.has(key)) throw new Error("GITHUB_ROUTE_AMBIGUOUS");
      routeKeys.add(key);
      candidates.push({ file, pathTemplate, method: routeFunction.method, sourceFile, functionNode: routeFunction.node, imports });
    }
  }
  candidates.sort((left, right) => compareStrings(`${left.method} ${left.pathTemplate}`, `${right.method} ${right.pathTemplate}`));
  const facts = candidateFacts(candidates, snapshot);
  const evidencePayload = {
    adapter: "github-nextjs-source",
    adapterVersion: 1,
    installationId: snapshot.installationId,
    repositoryId: snapshot.repositoryId,
    repository: `${snapshot.owner}/${snapshot.repository}`,
    requestedRef: snapshot.requestedRef,
    commitSha: snapshot.commitSha,
    snapshotReference: snapshot.reference,
    targetOrigin: options.targetOrigin,
    routes: facts.map(({ fact }) => fact),
  };
  const content = canonicalJson(evidencePayload);
  if (Buffer.byteLength(content, "utf8") > MAX_EVIDENCE_BYTES) throw new Error("GITHUB_EVIDENCE_LIMIT_EXCEEDED");
  const reference = `urn:sha256:${sha256(content)}`;
  const diagnostics: GitHubSourceDiagnostic[] = [];
  const plans: CapabilityPlan[] = [];
  for (const { candidate, fact, requestSchema, outputSchema } of facts) {
    if (fact.authorization === "unknown") diagnostics.push({ code: "AUTHORIZATION_UNCONFIRMED", operationKey: fact.operationKey });
    if (!requestSchema) diagnostics.push({ code: "REQUEST_VALIDATION_UNCONFIRMED", operationKey: fact.operationKey });
    if (!outputSchema) diagnostics.push({ code: "RESPONSE_VALIDATION_UNCONFIRMED", operationKey: fact.operationKey });
    if (fact.authorization === "unknown" || !requestSchema || !outputSchema) continue;
    const pathFields = [...candidate.pathTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
    if (pathFields.some((field) => !Object.prototype.hasOwnProperty.call(requestSchema.properties, field)
      || !requestSchema.required.includes(field))) {
      diagnostics.push({ code: "UNSUPPORTED_ROUTE", operationKey: fact.operationKey });
      continue;
    }
    if (fact.services.length === 0) {
      diagnostics.push({ code: "SERVICE_LINKAGE_UNCONFIRMED", operationKey: fact.operationKey });
      continue;
    }
    try {
      plans.push(buildPlan(candidate, requestSchema, outputSchema, reference, options.targetOrigin, fact.idempotency === "verified_header"));
    } catch {
      diagnostics.push({ code: "CANONICAL_PLAN_UNSUPPORTED", operationKey: fact.operationKey });
    }
  }
  if (facts.length === 0) diagnostics.push({ code: "UNSUPPORTED_REPOSITORY", operationKey: snapshot.commitSha });
  diagnostics.sort((left, right) => compareStrings(`${left.operationKey}\0${left.code}`, `${right.operationKey}\0${right.code}`));
  return {
    plans: plans.length === 0 ? [] : [...canonicalizeCapabilityPlans(plans)],
    diagnostics,
    evidence: { source: "github", content, reference },
  };
}

function generatedFile(path: string, content: string): GeneratedSourceNativeFile {
  return { path, content, contentHash: sha256(content) };
}

export function generateSourceNativeChange(
  snapshot: GitHubSourceSnapshot,
  analysis: GitHubSourceAnalysis,
): SourceNativeChange {
  assertSnapshot(snapshot);
  if (analysis.plans.length === 0 || !/^urn:sha256:[a-f0-9]{64}$/.test(analysis.evidence.reference)
    || analysis.plans.some((plan) => !plan.evidence.some(({ source, reference }) => source === "github" && reference === analysis.evidence.reference))) {
    throw new Error("GITHUB_SOURCE_NATIVE_CHANGE_INVALID");
  }
  const release = compileWebMcpRelease(analysis.plans);
  const manifestDigest = sha256(canonicalJson(release.manifest));
  const files = [
    generatedFile("app/_page2webmcp/register.generated.mjs", `${release.code}\n`),
    generatedFile("docs/page2webmcp-security.md", [
      "# Page2WebMCP source-native installation",
      "",
      `This draft binds the reviewed capability plans to immutable source evidence \`${analysis.evidence.reference}\`.`,
      `The generated runtime manifest digest is \`${manifestDigest}\` and its allowed origin is \`${release.allowedOrigin}\`.`,
      "Review the canonical plans and generated test before merging. This draft does not merge, deploy, or mark an installation successful.",
      "Mutations retain explicit confirmation and idempotency semantics from the canonical plan.",
      "",
    ].join("\n")),
    generatedFile("tests/page2webmcp/tools.test.ts", [
      'import assert from "node:assert/strict";',
      'import { createHash } from "node:crypto";',
      'import { readFile } from "node:fs/promises";',
      'import test from "node:test";',
      "",
      'test("generated Page2WebMCP runtime remains content-addressed", async () => {',
      '  const runtime = await readFile(new URL("../../app/_page2webmcp/register.generated.mjs", import.meta.url));',
      `  assert.equal(createHash("sha256").update(runtime).digest("hex"), "${sha256(`${release.code}\n`)}");`,
      "});",
      "",
    ].join("\n")),
  ].sort((left, right) => compareStrings(left.path, right.path));
  const patchIdentity = {
    version: 1,
    baseCommitSha: snapshot.commitSha,
    snapshotReference: snapshot.reference,
    evidenceReference: analysis.evidence.reference,
    releaseContentHash: release.contentHash,
    files: files.map(({ path, contentHash }) => ({ path, contentHash })),
  };
  return {
    version: 1,
    baseCommitSha: snapshot.commitSha,
    patchDigest: sha256(canonicalJson(patchIdentity)),
    files,
    release,
  };
}
