import assert from "node:assert/strict";
import test from "node:test";
import {
  probeConfiguredWebsiteControlStartup,
  websiteMissingControls,
} from "../../worker/src/website-live.ts";
import type { NodePinnedJsonTransport } from "../../worker/src/node-network.ts";
import { startGateway, testEnvironment, TEST_BROWSER_USE_KEY, TEST_KMS_KEY_ID, TEST_TOKENS } from "./harness.ts";

const upstream = {
  verifyCredentials: async () => ({ apiVersion: "v4" as const, authenticated: true as const, model: "browser-use-2.0" as const }),
  startSession: async () => { throw new Error("UNUSED"); },
  stopSession: async () => undefined,
  reconcileSession: async () => ({ terminated: true as const }),
};

/**
 * The worker refuses anything but exact HTTPS origins, so the two deployed
 * origins are mapped onto the two local test servers here. Every request and
 * every response is otherwise the real client's.
 */
function routingTransport(routes: Readonly<Record<string, string>>): NodePinnedJsonTransport {
  return {
    request: async ({ url, method, headers, body, signal }) => {
      const target = new URL(url);
      const local = routes[target.origin];
      if (!local) throw new Error("UNROUTED_ORIGIN");
      const response = await fetch(`${local}${target.pathname}`, {
        method,
        headers,
        body: method === "GET" ? undefined : body,
        signal,
      });
      return {
        status: response.status,
        url,
        headers: Object.fromEntries(response.headers.entries()),
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}

function workerEnvironment(): Record<string, string> {
  return {
    PAGE2WEBMCP_PROVIDER_MODE: "website",
    PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN: "https://auth-handoff.example",
    PAGE2WEBMCP_AUTH_HANDOFF_TOKEN: TEST_TOKENS["authentication-handoff"],
    PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN: "https://controls.example",
    PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN: TEST_TOKENS["browser-lease-store"],
    PAGE2WEBMCP_BROWSER_USE_API_KEY: TEST_BROWSER_USE_KEY,
    PAGE2WEBMCP_BROWSER_USE_API_ORIGIN: "https://browser-gateway.example",
    PAGE2WEBMCP_CDP_OBSERVER_ORIGIN: "https://controls.example",
    PAGE2WEBMCP_CDP_OBSERVER_TOKEN: TEST_TOKENS["cdp-observer"],
    PAGE2WEBMCP_EGRESS_POLICY_ORIGIN: "https://controls.example",
    PAGE2WEBMCP_EGRESS_POLICY_TOKEN: TEST_TOKENS["egress-policy-store"],
    PAGE2WEBMCP_EGRESS_PROXY_ORIGIN: "https://controls.example",
    PAGE2WEBMCP_EGRESS_PROXY_TOKEN: TEST_TOKENS["egress-proxy"],
    PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN: "https://controls.example",
    PAGE2WEBMCP_EVIDENCE_STORE_TOKEN: TEST_TOKENS["evidence-store"],
    PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN: "https://controls.example",
    PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN: TEST_TOKENS["ownership-store"],
    PAGE2WEBMCP_PUBLIC_ORIGIN:
      "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
    PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID: TEST_KMS_KEY_ID,
    PAGE2WEBMCP_SECRET_STORE_ORIGIN: "https://controls.example",
    PAGE2WEBMCP_SECRET_STORE_TOKEN: TEST_TOKENS["ttl-secret-store"],
  };
}

test("the worker's own readiness client accepts this gateway across the required origin split", async () => {
  assert.deepEqual(websiteMissingControls(workerEnvironment()), []);
  const shared = await startGateway(testEnvironment({
    PAGE2WEBMCP_GATEWAY_CONTROLS: [
      "browser-lease-store", "cdp-observer", "egress-policy-store", "egress-proxy",
      "evidence-store", "ownership-store", "ttl-secret-store",
    ].join(","),
  }));
  const authentication = await startGateway(testEnvironment({
    PAGE2WEBMCP_GATEWAY_CONTROLS: "authentication-handoff",
  }));
  const browser = await startGateway(testEnvironment({
    PAGE2WEBMCP_GATEWAY_CONTROLS: "browser-use-v4",
  }), { browserUseUpstream: upstream });
  try {
    await probeConfiguredWebsiteControlStartup(workerEnvironment(), {
      controlTransport: routingTransport({
        "https://controls.example": shared.origin,
        "https://auth-handoff.example": authentication.origin,
        "https://browser-gateway.example": browser.origin,
      }),
    }, new AbortController().signal);
  } finally {
    await Promise.all([shared.close(), authentication.close(), browser.close()]);
  }
});

test("the worker's readiness client rejects a gateway that is missing a control", async () => {
  const shared = await startGateway(testEnvironment({
    PAGE2WEBMCP_GATEWAY_CONTROLS: [
      "browser-lease-store", "cdp-observer", "egress-policy-store", "egress-proxy",
      "evidence-store", "ownership-store",
    ].join(","),
  }));
  const authentication = await startGateway(testEnvironment({
    PAGE2WEBMCP_GATEWAY_CONTROLS: "authentication-handoff",
  }));
  const browser = await startGateway(testEnvironment({
    PAGE2WEBMCP_GATEWAY_CONTROLS: "browser-use-v4",
  }), { browserUseUpstream: upstream });
  try {
    await assert.rejects(probeConfiguredWebsiteControlStartup(workerEnvironment(), {
      controlTransport: routingTransport({
        "https://controls.example": shared.origin,
        "https://auth-handoff.example": authentication.origin,
        "https://browser-gateway.example": browser.origin,
      }),
    }, new AbortController().signal), /WEBSITE_PROVIDER_PROBE_FAILED/);
  } finally {
    await Promise.all([shared.close(), authentication.close(), browser.close()]);
  }
});
