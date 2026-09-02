import type { ControlName } from "../constants.ts";

export type RouteKind = "worker" | "user" | "either";

export type RouteDefinition = Readonly<{ control: ControlName; kind: RouteKind }>;

/**
 * Every control route, mapped to the single control whose credential may reach
 * it. A path never appears twice, so a credential can never be checked against
 * a control other than the one that owns the operation.
 */
export const CONTROL_ROUTES: Readonly<Record<string, RouteDefinition>> = Object.freeze({
  "/v1/authentication/checkpoints/create": { control: "authentication-handoff", kind: "worker" },
  "/v1/authentication/checkpoints/status": { control: "authentication-handoff", kind: "either" },
  "/v1/authentication/checkpoints/resume": { control: "authentication-handoff", kind: "worker" },
  "/v1/authentication/checkpoints/finalize": { control: "authentication-handoff", kind: "worker" },
  "/v1/authentication/checkpoints/reconcile": { control: "authentication-handoff", kind: "worker" },
  "/v1/authentication/checkpoints/portal": { control: "authentication-handoff", kind: "user" },
  "/v1/browser-leases/claim": { control: "browser-lease-store", kind: "worker" },
  "/v1/browser-leases/release": { control: "browser-lease-store", kind: "worker" },
  "/v1/browser-use-v4/sessions/start": { control: "browser-use-v4", kind: "worker" },
  "/v1/browser-use-v4/sessions/stop": { control: "browser-use-v4", kind: "worker" },
  "/v1/browser-use-v4/sessions/reconcile": { control: "browser-use-v4", kind: "worker" },
  "/v1/ttl-secrets/put": { control: "ttl-secret-store", kind: "worker" },
  "/v1/ttl-secrets/revoke": { control: "ttl-secret-store", kind: "worker" },
  "/v1/website-egress-policies/issue": { control: "egress-policy-store", kind: "worker" },
  "/v1/website-egress-policies/apply": { control: "egress-proxy", kind: "worker" },
  "/v1/website-evidence/put": { control: "evidence-store", kind: "worker" },
  "/v1/website-evidence/get": { control: "evidence-store", kind: "worker" },
  "/v1/website-observations/observe": { control: "cdp-observer", kind: "worker" },
  "/v1/website-ownership/challenges/load": { control: "ownership-store", kind: "worker" },
  "/v1/website-ownership/replays/consume": { control: "ownership-store", kind: "worker" },
  "/v1/website-ownership/source-attestations/consume": { control: "ownership-store", kind: "worker" },
  "/v1/website-ownership/source-attestations/issue": { control: "ownership-store", kind: "user" },
  "/v1/website-ownership/source-attestations/status": { control: "ownership-store", kind: "user" },
  "/v1/website-ownership/source-attestations/check": { control: "ownership-store", kind: "user" },
});

/**
 * Policy revocation is the one operation both egress controls own: the store
 * revokes what it issued, the proxy stops enforcing what it applied. Each is
 * authorized against its own credential.
 */
export const POLICY_REVOKE_PATH = "/v1/website-egress-policies/revoke";
export const POLICY_REVOKE_CONTROLS: readonly ControlName[] = Object.freeze([
  "egress-policy-store",
  "egress-proxy",
]);
