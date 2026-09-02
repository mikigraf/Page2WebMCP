import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { VerifierConfig, VerifierSessionCookie } from "./config.ts";

/**
 * Real browser access. The verifier drives a genuine Chromium page: it never installs a route
 * handler, never stubs a request, and never runs an init script, so anything the page does is
 * the page's own behaviour. The only page-context evaluation performed is read-only observation
 * plus tool invocation through the page's own WebMCP surface.
 *
 * The configured Blink runtime features are enabled at launch. WebMCP is still flagged in current
 * Chromium, and it is exposed only to a secure context, so a page served over HTTPS (or loopback)
 * in a browser launched with that feature gets the genuine `document.modelContext` from
 * `Document.prototype`. Enabling a browser feature is not injection: the page still registers its
 * own tools through the browser's own API, and the verifier observes the result.
 */

export type BrowserSession = Readonly<{
  page: Page;
  context: BrowserContext;
  close(): Promise<void>;
}>;

export function chromiumUnavailableReason(): string | undefined {
  try {
    const path = chromium.executablePath();
    if (!path || !existsSync(path)) {
      return "Chromium is not installed for Playwright (run: pnpm exec playwright install chromium)";
    }
    return undefined;
  } catch (error) {
    return `Chromium is unavailable: ${error instanceof Error ? error.name : "unknown"}`;
  }
}

export async function openBrowserSession(input: Readonly<{
  config: VerifierConfig;
  targetOrigin: string;
}>): Promise<BrowserSession> {
  const features = input.config.browser.blinkFeatures;
  const browser: Browser = await chromium.launch({
    headless: input.config.browser.headless,
    ...(input.config.browser.executablePath ? { executablePath: input.config.browser.executablePath } : {}),
    ...(features.length > 0 ? { args: [`--enable-blink-features=${features.join(",")}`] } : {}),
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: false, javaScriptEnabled: true });
    context.setDefaultTimeout(input.config.timeouts.navigationMs);
    context.setDefaultNavigationTimeout(input.config.timeouts.navigationMs);
    const cookies = sessionCookiesFor(input.config.targetSessionCookies, input.targetOrigin);
    if (cookies.length > 0) await context.addCookies(cookies);
    const page = await context.newPage();
    return Object.freeze({
      page,
      context,
      close: async () => {
        try {
          await context.close();
        } finally {
          await browser.close();
        }
      },
    });
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** Cookies are applied only to the target origin the request scope names, and never logged. */
function sessionCookiesFor(
  cookies: readonly VerifierSessionCookie[],
  targetOrigin: string,
): Array<VerifierSessionCookie & { secure: boolean }> {
  const origin = new URL(targetOrigin);
  const host = origin.hostname;
  return cookies
    .filter((cookie) => cookie.domain === host || (cookie.domain.startsWith(".") && host.endsWith(cookie.domain.slice(1))))
    .map((cookie) => ({
      ...cookie,
      secure: cookie.secure ?? origin.protocol === "https:",
    }));
}
