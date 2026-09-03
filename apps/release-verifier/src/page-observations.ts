import type { Page } from "@playwright/test";

/**
 * Read-only observations of a real page. Every function here reports what the page already is;
 * none of them register a tool, define a WebMCP surface, or modify page state.
 */

export type ScriptTagObservation = Readonly<{
  src: string;
  integrity: string;
  crossOrigin: string;
  type: string;
}>;

export type WebMcpSurface = Readonly<{
  present: boolean;
  native: boolean;
  ownProperty: boolean;
  nativeRegisterTool: boolean;
}>;

export type ModuleExecution = Readonly<{
  status: string;
  registeredToolNames: readonly string[];
}>;

export async function observeScriptTag(page: Page, artifactUrl: string): Promise<ScriptTagObservation | undefined> {
  const observed = await page.evaluate((url) => {
    const scripts = [...document.querySelectorAll("script[src]")] as HTMLScriptElement[];
    const match = scripts.find((script) => {
      try {
        return new URL(script.getAttribute("src") ?? "", document.baseURI).href === url;
      } catch {
        return false;
      }
    });
    if (!match) return undefined;
    return {
      src: new URL(match.getAttribute("src") ?? "", document.baseURI).href,
      integrity: match.getAttribute("integrity") ?? "",
      crossOrigin: match.getAttribute("crossorigin") ?? "",
      type: match.getAttribute("type") ?? "",
    };
  }, artifactUrl);
  return observed ?? undefined;
}

export async function observeTargetOrigin(page: Page): Promise<string> {
  return await page.evaluate(() => window.location.origin);
}

/**
 * "native" means the browser itself exposes document.modelContext: the property comes from
 * Document.prototype rather than from an own property assigned by page script, and registerTool
 * is a native function. Anything else - including a page-installed compatibility object and a
 * page with no WebMCP at all - is reported as not native.
 */
export async function observeWebMcpSurface(page: Page): Promise<WebMcpSurface> {
  return await page.evaluate(() => {
    const target = document as Document & { modelContext?: { registerTool?: unknown } };
    const context = target.modelContext;
    const ownProperty = Object.getOwnPropertyDescriptor(document, "modelContext") !== undefined;
    const prototypeProperty = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext") !== undefined;
    const register = context?.registerTool;
    const nativeRegisterTool = typeof register === "function"
      && Function.prototype.toString.call(register).includes("[native code]");
    return {
      present: !!context,
      ownProperty,
      nativeRegisterTool,
      native: !!context && !ownProperty && prototypeProperty && nativeRegisterTool,
    };
  });
}

export async function observeRegisteredTools(page: Page): Promise<readonly string[]> {
  const names = await page.evaluate(async () => {
    const target = document as Document & { modelContext?: { getTools?: () => Promise<unknown> } };
    const context = target.modelContext;
    if (!context || typeof context.getTools !== "function") return [];
    try {
      const tools = await context.getTools();
      if (!Array.isArray(tools)) return [];
      return tools.slice(0, 100).map((tool) => String((tool as { name?: unknown })?.name ?? ""));
    } catch {
      return [];
    }
  });
  return Object.freeze([...new Set(names.filter((name) => /^[a-z][a-z0-9_]{0,63}$/.test(name)))].sort());
}

export async function observeModuleExecution(page: Page, releaseId: string): Promise<ModuleExecution | undefined> {
  const observed = await page.evaluate((key) => {
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("page2webmcp.release.registry.v1")];
    if (!(registry instanceof Map)) return undefined;
    const state = registry.get(key) as { status?: unknown; registeredToolNames?: unknown } | undefined;
    if (!state) return undefined;
    return {
      status: String(state.status ?? ""),
      registeredToolNames: Array.isArray(state.registeredToolNames)
        ? state.registeredToolNames.slice(0, 100).map((name) => String(name))
        : [],
    };
  }, releaseId);
  return observed ?? undefined;
}

/**
 * Loads the already-executed module a second time and asks it to register again. The module map
 * returns the same instance, so this exercises the release's own duplicate-registration path
 * rather than injecting a second registration. Returns null when the module never executed.
 */
export async function probeDuplicateLoad(page: Page, artifactUrl: string): Promise<boolean | null> {
  const before = await observeRegisteredTools(page);
  // Evaluated from a source string rather than a function: a literal
  // `import(url)` inside a page.evaluate callback compiles, under this
  // package's rewriteRelativeImportExtensions build option, to a call to a
  // per-file runtime helper the compiler emits alongside it. page.evaluate
  // ships only the extracted callback body to the browser, so that helper
  // never travels with it and a real dynamic import throws ReferenceError
  // there. A string is opaque to that compile-time rewrite; the artifact
  // URL is JSON-encoded into it, never concatenated, so it cannot break out
  // of the string it's embedded in.
  const probeSource = `(async () => {
    try {
      const loaded = await import(${JSON.stringify(artifactUrl)});
      if (typeof loaded.registerPage2WebMCPTools !== "function") return { attempted: false, supported: false, detail: "no_register_export" };
      const outcome = await loaded.registerPage2WebMCPTools();
      return { attempted: true, supported: outcome?.supported === true, detail: outcome?.reason ?? "" };
    } catch (error) {
      return { attempted: true, supported: false, detail: error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error) };
    }
  })()`;
  const result = await page.evaluate(probeSource) as
    Readonly<{ attempted: boolean; supported: boolean; detail: string }>;
  if (!result.attempted) return null;
  const after = await observeRegisteredTools(page);
  const harmless = result.supported && before.length === after.length && before.every((name, index) => name === after[index]);
  // The stable duplicateLoadHarmless field alone gives no way to attribute a
  // live refusal: log the raw probe outcome and tool sets on the verifier
  // itself (never sent to the control plane) so the next occurrence is
  // diagnosable without another blind guess.
  if (!harmless) {
    console.error(JSON.stringify({
      level: "error", event: "duplicate_load_probe_failed",
      supported: result.supported, detail: result.detail, before, after,
    }));
  }
  return harmless;
}
