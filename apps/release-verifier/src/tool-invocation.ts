import type { Page } from "@playwright/test";

/**
 * Tool invocation through the page's own WebMCP surface. The verifier acts as a caller here, the
 * way an agent would: it looks up an already-registered tool and executes it. It never registers,
 * replaces, or wraps a tool.
 *
 * Two surfaces exist in the wild and they are called differently:
 *
 * - The native `ModelContext` (Chromium, behind the WebMCP Blink feature) hands `getTools()` back
 *   plain descriptors - name, title, description, inputSchema, annotations, origin, window - with
 *   no `execute` on them. A call goes through `modelContext.executeTool(descriptor, argumentsJson)`,
 *   where the arguments are a JSON *string* and the result comes back as a JSON *string* of
 *   whatever the page's own tool function returned.
 * - A page-installed compatibility object typically keeps `execute` on the tool itself and takes a
 *   caller `AbortSignal`, which is how the candidate lane's loader surface behaves.
 *
 * The native surface has no caller-side cancellation: `executeTool` takes no signal and the page's
 * tool function is invoked with the input alone. So a cancellation request cannot be honoured
 * there, and it is reported as unsupported rather than being reported as a cancellation.
 */

export type ToolOutcome = Readonly<{ ok: boolean; output?: unknown; error?: string; detail?: string }>;

/** Error reported when a cancellation was asked for on a surface that cannot express one. */
export const CANCELLATION_UNSUPPORTED = "CANCELLATION_UNSUPPORTED";

export async function runTool(
  page: Page,
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  timeoutMs: number,
  options: Readonly<{ abortImmediately?: boolean }> = {},
): Promise<ToolOutcome> {
  try {
    return await withTimeout(page.evaluate(async ([name, args, abort]) => {
      const target = document as Document & {
        modelContext?: {
          getTools?: () => Promise<unknown>;
          executeTool?: (tool: unknown, argumentsJson: string) => Promise<unknown>;
        };
      };
      const context = target.modelContext;
      if (!context || typeof context.getTools !== "function") return { ok: false, error: "WEBMCP_UNAVAILABLE" };
      const tools = await context.getTools() as Array<{
        name?: string;
        execute?: (value: unknown, executionContext?: unknown) => Promise<unknown>;
      }>;
      const tool = Array.isArray(tools) ? tools.find((entry) => entry?.name === name) : undefined;
      if (!tool) return { ok: false, error: "TOOL_UNAVAILABLE" };
      if (typeof tool.execute === "function") {
        const controller = new AbortController();
        if (abort) controller.abort(new Error("CANCELLED"));
        try {
          return { ok: true, output: await tool.execute(args, { signal: controller.signal }) };
        } catch (error) {
          const failure = error as { code?: string; name?: string; message?: string };
          return {
            ok: false,
            error: String(failure?.code ?? "EXECUTION_FAILED"),
            detail: `name=${String(failure?.name ?? "")} message=${String(failure?.message ?? "")} code=${String(failure?.code ?? "")}`,
          };
        }
      }
      if (typeof context.executeTool !== "function") return { ok: false, error: "TOOL_UNAVAILABLE" };
      // Native surface: no caller signal exists, so a cancellation cannot be performed here.
      if (abort) return { ok: false, error: "CANCELLATION_UNSUPPORTED" };
      try {
        const result = await context.executeTool(tool, JSON.stringify(args));
        if (typeof result !== "string") return { ok: true, output: result };
        try {
          return { ok: true, output: JSON.parse(result) as unknown };
        } catch {
          return { ok: true, output: result };
        }
      } catch (error) {
        return { ok: false, error: String((error as { code?: string })?.code ?? "EXECUTION_FAILED") };
      }
    }, [toolName, toolInput, options.abortImmediately === true] as [
      string,
      Record<string, unknown>,
      boolean,
    ]), timeoutMs);
  } catch {
    return { ok: false, error: "DEADLINE_EXCEEDED" };
  }
}

/**
 * Runs a tool and answers its confirmation the way a person does: by pressing keys against
 * whatever modal the release itself opened. The release's built-in dialog lives in a closed
 * shadow root and focuses Cancel, so Tab moves to Confirm and Enter activates it; pressing
 * Escape instead declines. If no dialog appears the run is reported as unconfirmed.
 */
export async function runToolWithConfirmation(
  page: Page,
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  timeoutMs: number,
  decision: "confirm" | "decline" = "confirm",
): Promise<ToolOutcome & Readonly<{ dialogObserved: boolean }>> {
  const baseline = await page.evaluate(() => document.body.childElementCount);
  const execution = runTool(page, toolName, toolInput, timeoutMs);
  const dialogObserved = await waitForModal(page, baseline, timeoutMs);
  if (dialogObserved) {
    if (decision === "confirm") {
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
    } else {
      await page.keyboard.press("Enter");
    }
  }
  const outcome = await execution;
  return { ...outcome, dialogObserved };
}

async function waitForModal(page: Page, baseline: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (Date.now() < deadline) {
    const opened = await page.evaluate((count) => document.body.childElementCount > count, baseline)
      .catch(() => false);
    if (opened) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, rejectOperation) => {
        timer = setTimeout(() => rejectOperation(new Error("DEADLINE_EXCEEDED")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
