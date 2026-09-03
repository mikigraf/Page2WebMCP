import assert from "node:assert/strict";
import test from "node:test";
import { startGateway, testEnvironment, envelope, canonicalJson, sha256Hex, TEST_KMS_KEY_ID, TEST_TOKENS } from "./harness.ts";

const observerToken = TEST_TOKENS["cdp-observer"];
const secretToken = TEST_TOKENS["ttl-secret-store"];
const TARGET = "https://widgets.example";
const SOURCE_URL = `${TARGET}/app`;
const routePolicy = { denyByDefault: true, routes: [{ methods: ["GET", "HEAD"], origin: TARGET, pathPrefix: "/" }] };

function observation() {
  return {
    navigations: [{ sequence: 1, url: SOURCE_URL, origin: TARGET }],
    semanticTargets: [],
    network: [],
    forms: [],
    dom: [],
    authSignals: [],
    blockedMutations: [],
    stateTransitions: [],
  };
}

async function storedCdpReference(gateway: Awaited<ReturnType<typeof startGateway>>): Promise<string> {
  const value = "wss://session.cdp.browser-use.example/";
  const put = await gateway.json("/v1/ttl-secrets/put", envelope("secret-put", {
    value,
    purpose: "browser_cdp_url",
    expiresAt: "2026-08-31T12:09:00.000Z",
    valueDigest: sha256Hex(value),
    kmsKeyId: TEST_KMS_KEY_ID,
  }), { token: secretToken });
  assert.equal(put.status, 200);
  return String(put.body?.reference);
}

function observeRequest(cdpReference: string, phase: string) {
  return envelope(`observe-${phase}`, {
    phase,
    targetOrigin: TARGET,
    sourceUrl: SOURCE_URL,
    cdpReference,
    routePolicy,
    routePolicyDigest: sha256Hex(canonicalJson(routePolicy)),
  });
}

test("observation accepts exactly the two wire phases and refuses any other name", async () => {
  const seen: string[] = [];
  const gateway = await startGateway(testEnvironment(), {
    clock: () => new Date("2026-08-31T12:00:00.000Z"),
    cdpObserver: {
      observe: async (input) => {
        seen.push(input.phase);
        // The deny-by-default gate must be consulted for the observation to count.
        input.allow("GET", `${TARGET}/`);
        return { observations: observation(), requiresAuthentication: false };
      },
    },
  });
  try {
    const cdpReference = await storedCdpReference(gateway);
    for (const phase of ["unauthenticated", "authenticated"] as const) {
      const accepted = await gateway.json("/v1/website-observations/observe", observeRequest(cdpReference, phase), { token: observerToken });
      assert.equal(accepted.status, 200, `${phase} is a supported phase`);
    }
    assert.deepEqual(seen, ["unauthenticated", "authenticated"]);

    // "public" names an observed authentication result, never a request phase.
    for (const phase of ["public", "", "UNAUTHENTICATED"]) {
      const rejected = await gateway.json("/v1/website-observations/observe", observeRequest(cdpReference, phase), { token: observerToken });
      assert.equal(rejected.status, 400, `${phase} is not a wire phase`);
      assert.equal(rejected.body?.error, "GATEWAY_OBSERVATION_REQUEST_INVALID");
    }
    assert.equal(seen.length, 2, "a refused phase never reaches the observer");
  } finally { await gateway.close(); }
});
