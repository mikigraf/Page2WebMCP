# @page2webmcp/release-verifier

The reference HTTPS release verifier. The control plane signs a protocol v2 request
(`apps/control-plane/src/release-verifier-protocol-v2.ts`); this service verifies it, drives a real
Chromium page against a real target, and returns a signed attestation containing only what it
observed. It never synthesises a passing result and fails closed on anything it cannot observe.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST /v2/readiness` | Authenticated health and compatibility handshake. |
| `POST /v2/candidates/verify` | Evaluate candidate bytes under a trusted loader. |
| `POST /v2/installations/verify` | Verify an installed release on a real page. |

Every request must carry `authorization: Bearer <token>` and
`x-page2webmcp-signature: hmac-sha256=<hex>` over the exact canonical body. Both are compared in
constant time before any other work. Expired, future-dated, overlong-lifetime, digest-mismatched,
replayed, or oversized requests are refused. Successful responses are canonical JSON signed with
the same shared token.

## Environment

Required (startup fails with the sorted list of missing names):

| Name | Holds |
| --- | --- |
| `PAGE2WEBMCP_RELEASE_VERIFIER_BIND_ADDRESS` | Listen address, for example `0.0.0.0`. |
| `PAGE2WEBMCP_RELEASE_VERIFIER_PORT` | Listen port. |
| `PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN` | Shared 32-4096 character verifier token. Never logged. |
| `PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS` | Comma separated exact origins the verifier may visit. |
| `PAGE2WEBMCP_RELEASE_VERIFIER_CONTROL_PLANE_ORIGIN` | Control plane origin, counted as forbidden traffic during execution. |
| `PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_HEADLESS` | `true` or `false`. |
| `PAGE2WEBMCP_RELEASE_VERIFIER_REPLAY_STORE_PATH` | Durable replay log path; empty string means in-memory only. |

Optional: `PAGE2WEBMCP_RELEASE_VERIFIER_MODE` (`live`, default), `..._ALLOW_LOOPBACK_TARGETS`,
`..._ARTIFACT_ORIGIN`, `..._MODEL_ORIGINS`, `..._DEPLOYMENT_IDENTITY_DIGESTS`,
`..._BROWSER_EXECUTABLE_PATH`, `..._BROWSER_BLINK_FEATURES`, `..._NAVIGATION_TIMEOUT_MS`,
`..._REQUEST_TIMEOUT_MS`, `..._TOOL_TIMEOUT_MS`, `..._MAX_ARTIFACT_BYTES`, `..._MAX_RESPONSE_BYTES`, `..._REPLAY_ENTRIES`,
`..._TARGET_SESSION_COOKIES` (JSON array; secret), `..._EXECUTION_PLAN` (JSON naming the read,
mutation and final-state tools plus their inputs; `{{marker}}` in a mutation string input is
replaced with a fresh unique marker the final-state read must show).

Without `..._TARGET_SESSION_COOKIES` and `..._EXECUTION_PLAN` the installation lane reports
`executionEvidence: null` and the candidate lane refuses, because no execution can be observed.

## The WebMCP surface

Native WebMCP exists and is observable. Chromium implements it behind the `WebMCP` Blink runtime
feature and exposes it only to a secure context, so a page served over HTTPS (or over loopback) in
a browser launched with that feature gets a genuine `document.modelContext` from
`Document.prototype`. `..._BROWSER_BLINK_FEATURES` names the features the observation browser
enables; it defaults to `WebMCP`, an empty value launches with none, and the name can be dropped
once the feature ships unflagged. Enabling a browser feature is not injection: the page still
registers its own tools through the browser's own API.

Verified against Chromium 151.0.7922.34 over a loopback origin:

- `document.modelContext` is a `ModelContext` whose prototype carries `registerTool`, `getTools`,
  `executeTool` and `ontoolchange`; `registerTool` is a genuine native function.
- `registerTool(tool, { signal })` is honoured - aborting that signal unregisters the tool.
- `getTools()` returns plain descriptors (`name`, `title`, `description`, `inputSchema`,
  `annotations`, `origin`, `window`). They carry **no** `execute`, and `inputSchema` comes back as a
  JSON *string*.
- A call therefore goes through `modelContext.executeTool(descriptor, argumentsJson)`, where the
  arguments are a JSON string and the result is a JSON string of whatever the page's tool returned.
  No `AbortSignal` is passed to either the caller or the page's tool function, so a native call
  cannot be cancelled by the caller, and the tool's own error code is replaced by a generic
  `UnknownError`. The native surface does not validate input against the declared schema; the
  release does that itself.
- Of the annotations, this build reports back only `readOnlyHint` and `untrustedContentHint`;
  `destructiveHint` is accepted at registration but not surfaced by `getTools()`.

The installation lane calls through whichever surface the page has, and reports
`webMcpImplementation: "native"` only when `document.modelContext` comes from `Document.prototype`
with a native `registerTool`. The candidate lane always supplies its own loader surface - the bytes
are not installed anywhere yet, and its cancellation check needs the caller `AbortSignal` that the
native API does not offer - and its report makes no claim about native support.

## Deploying

```
pnpm build:identity
docker build -f deploy/Dockerfile.release-verifier \
  --build-arg NODE_BASE_IMAGE=node@sha256:<digest> \
  --build-arg PAGE2WEBMCP_GIT_COMMIT_SHA=<sha> \
  --build-arg PAGE2WEBMCP_APPLICATION_RELEASE_ID=<id> \
  --build-arg PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN=https://<control-plane> .
```

Run it behind TLS termination with a certificate for the public verifier origin, then point the
control plane at it with `PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN=https://<verifier-origin>` (exact
origin, no path) and the same `PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN` on both sides.
