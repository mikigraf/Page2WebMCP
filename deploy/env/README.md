# Production-live environment templates

A production-live journey runs **four separate deployments**. Each has its own environment;
none of them shares an `.env` file with another.

| Deployment | Template | Notes |
| --- | --- | --- |
| Control plane + worker | `../../.env.example` | The Page2WebMCP application itself |
| Release verifier | `release-verifier.env.example` | One HTTPS origin |
| Website control gateway | `website-gateway.env.example` | **Three** HTTPS origins, see below |
| Example target website | `example-target.env.example` | The site being analyzed and installed on |

The application template is complete on its own: every control the production-live preflight
requires is named in it. The other three are not part of that file because they are other
processes, and their secrets must not sit in the application environment.

## Values that must match across deployments

These are the same secret written into two places. A mismatch fails closed, usually as a
readiness or authentication error rather than an obvious configuration error.

| Application variable | Must equal | On |
| --- | --- | --- |
| `PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN` | `PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN` | release verifier |
| `PAGE2WEBMCP_AUTH_HANDOFF_TOKEN` | `PAGE2WEBMCP_GATEWAY_AUTH_HANDOFF_TOKEN` | gateway |
| `PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN` | `PAGE2WEBMCP_GATEWAY_BROWSER_LEASE_STORE_TOKEN` | gateway |
| `PAGE2WEBMCP_CDP_OBSERVER_TOKEN` | `PAGE2WEBMCP_GATEWAY_CDP_OBSERVER_TOKEN` | gateway |
| `PAGE2WEBMCP_EGRESS_POLICY_TOKEN` | `PAGE2WEBMCP_GATEWAY_EGRESS_POLICY_TOKEN` | gateway |
| `PAGE2WEBMCP_EGRESS_PROXY_TOKEN` | `PAGE2WEBMCP_GATEWAY_EGRESS_PROXY_TOKEN` | gateway |
| `PAGE2WEBMCP_EVIDENCE_STORE_TOKEN` | `PAGE2WEBMCP_GATEWAY_EVIDENCE_STORE_TOKEN` | gateway |
| `PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN` | `PAGE2WEBMCP_GATEWAY_OWNERSHIP_STORE_TOKEN` | gateway |
| `PAGE2WEBMCP_SECRET_STORE_TOKEN` | `PAGE2WEBMCP_GATEWAY_SECRET_STORE_TOKEN` | gateway |
| `PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID` | `PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_KEY_ID` | gateway |
| `PAGE2WEBMCP_BROWSER_USE_API_KEY` | `PAGE2WEBMCP_GATEWAY_BROWSER_USE_API_KEY` | gateway |

`PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_API_KEY` is different: it is the **real Browser Use
Cloud key**. The inbound key above is the credential the worker presents to your gateway, so the
two can be rotated independently.

Each `_ORIGIN` on the application side is the public HTTPS origin of the deployment that answers
it. The worker rejects a configuration where `PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN` equals
`PAGE2WEBMCP_BROWSER_USE_API_ORIGIN`, which is why the gateway runs as three processes:

- **controls origin** — `browser-lease-store,cdp-observer,egress-policy-store,egress-proxy,evidence-store,ownership-store,ttl-secret-store`
- **auth-handoff origin** — `authentication-handoff` alone
- **browser-use origin** — `browser-use-v4` alone

Point the seven matching application `_ORIGIN` variables at the controls origin,
`PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN` at the second, and `PAGE2WEBMCP_BROWSER_USE_API_ORIGIN` at the third.

## Values you cannot fill in before the first run

Four values only exist after a release has been published, so the journey is deliberately
two-phase. Leave them unset, run the journey until it stops with `INSTALLATION_ACTION_REQUIRED`,
then take the returned hash and integrity, set these, redeploy the target, and re-run with
`--confirm-installed <hash>`:

- `PAGE2WEBMCP_READINESS_RELEASE_HASH` (application)
- `PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL`, `..._RELEASE_CONTENT_HASH`, `..._RELEASE_INTEGRITY` (target)

`PAGE2WEBMCP_GIT_COMMIT_SHA` and `PAGE2WEBMCP_APPLICATION_RELEASE_ID` come from `pnpm build:identity`
and must equal what is baked into the images. A live run also requires the operator work tree to be
clean and its `HEAD` to equal that commit.

`PAGE2WEBMCP_LOCAL_STACK` and `PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN` must be **absent** from a
production-live environment. The preflight rejects a live run when either is present, because they
silently redirect Storage and the verifier to loopback.
