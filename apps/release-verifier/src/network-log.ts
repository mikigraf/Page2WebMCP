import { createHash } from "node:crypto";
import type { Page, Response } from "@playwright/test";

/**
 * A passive record of what the page did. Listeners only observe; nothing here changes, blocks,
 * or rewrites a request. URLs are kept without their query strings for credential safety, except
 * for the artifact URL the caller explicitly asks about.
 */

export type ObservedRequest = Readonly<{
  url: string;
  method: string;
  at: number;
  hasCookieHeader: boolean;
  cookieNames: readonly string[];
}>;

export type ObservedResponse = Readonly<{
  url: string;
  status: number;
  at: number;
}>;

export type NetworkLog = Readonly<{
  requests: readonly ObservedRequest[];
  responses: readonly ObservedResponse[];
  consoleErrors: readonly string[];
  settle(): Promise<void>;
  artifactBodyHash(): Promise<string | undefined>;
  artifactResponseUrl(): string | undefined;
  artifactStatus(): number | undefined;
}>;

export function attachNetworkLog(page: Page, artifactUrl: string): NetworkLog {
  type MutableRequest = {
    url: string;
    method: string;
    at: number;
    hasCookieHeader: boolean;
    cookieNames: string[];
  };
  const requests: MutableRequest[] = [];
  const pending: Array<Promise<void>> = [];
  const responses: ObservedResponse[] = [];
  const consoleErrors: string[] = [];
  let artifactResponse: Response | undefined;
  page.on("request", (request) => {
    // Cookie headers are only available from the resolved header set, so the entry is filled in
    // once Chromium reports them. Only cookie names are kept; values never enter the log.
    const entry: MutableRequest = {
      url: request.url(),
      method: request.method(),
      at: Date.now(),
      hasCookieHeader: false,
      cookieNames: [],
    };
    requests.push(entry);
    pending.push(request.allHeaders().then((headers) => {
      const cookie = headers.cookie ?? "";
      entry.hasCookieHeader = cookie.length > 0;
      entry.cookieNames = cookie.split(";")
        .map((value) => value.split("=", 1)[0]?.trim() ?? "")
        .filter(Boolean);
    }).catch(() => undefined));
  });
  page.on("response", (response) => {
    responses.push(Object.freeze({ url: response.url(), status: response.status(), at: Date.now() }));
    if (response.url() === artifactUrl && !artifactResponse) artifactResponse = response;
  });
  page.on("console", (message) => {
    if (message.type() === "error" && consoleErrors.length < 64) consoleErrors.push(message.text().slice(0, 1_024));
  });
  page.on("pageerror", (error) => {
    if (consoleErrors.length < 64) consoleErrors.push(`pageerror: ${error.message.slice(0, 512)}`);
  });
  return Object.freeze({
    requests,
    responses,
    consoleErrors,
    settle: async () => {
      await Promise.all([...pending]);
    },
    artifactResponseUrl: () => artifactResponse?.url(),
    artifactStatus: () => artifactResponse?.status(),
    artifactBodyHash: async () => {
      if (!artifactResponse) return undefined;
      try {
        const body = await artifactResponse.body();
        return createHash("sha256").update(body).digest("hex");
      } catch {
        return undefined;
      }
    },
  });
}

export function countForeignRequests(log: NetworkLog, origins: readonly string[]): number {
  return log.requests.filter((request) => {
    try {
      return origins.includes(new URL(request.url).origin);
    } catch {
      return false;
    }
  }).length;
}

export function mutatingRequestsWithin(
  log: NetworkLog,
  targetOrigin: string,
  from: number,
  to: number,
): readonly ObservedRequest[] {
  return log.requests.filter((request) => {
    if (request.at < from || request.at > to) return false;
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
    try {
      return new URL(request.url).origin === targetOrigin;
    } catch {
      return false;
    }
  });
}
