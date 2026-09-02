export type EgressRoute = Readonly<{
  methods: readonly string[];
  origin: string;
  pathPrefix: string;
}>;

export type EnforcedPolicy = Readonly<{
  reference: string;
  denyByDefault: true;
  routes: readonly EgressRoute[];
  targetOrigin: string;
  expiresAtMs: number;
}>;

export type EgressRequest = Readonly<{
  method: string;
  url: string;
  now: Date;
}>;

export type EgressEnforcer = Readonly<{
  install(policy: EnforcedPolicy): void;
  revoke(reference: string): boolean;
  check(request: EgressRequest): boolean;
}>;

/**
 * Deny-by-default route table. Every outbound request this process makes on a
 * run's behalf is checked here before it leaves, so `enforced: true` describes
 * a control that is actually installed and actually consulted.
 */
export function createEgressEnforcer(): EgressEnforcer {
  const installed = new Map<string, EnforcedPolicy>();
  return {
    install(policy) {
      installed.set(policy.reference, policy);
    },
    revoke(reference) {
      return installed.delete(reference);
    },
    check({ method, url, now }) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { return false; }
      for (const policy of installed.values()) {
        if (policy.expiresAtMs <= now.getTime()) { installed.delete(policy.reference); continue; }
        for (const route of policy.routes) {
          if (route.origin === parsed.origin && route.methods.includes(method)
            && parsed.pathname.startsWith(route.pathPrefix)) return true;
        }
      }
      return false;
    },
  };
}
