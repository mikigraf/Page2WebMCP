import type { BrowserUseCloudV4Request } from "../../../packages/providers/src/browser-use-v4.ts";
import type { WebsiteObservationInput } from "../../../packages/providers/src/website-evidence.ts";
import type { EgressEnforcer } from "./stores/enforcement.ts";
import type { AuthenticationSignal } from "./stores/checkpoints.ts";
import type { OwnershipVerifier } from "./stores/ownership.ts";

export type BrowserUseUpstreamAttestation = Readonly<{
  apiVersion: "v4";
  authenticated: true;
  model: "browser-use-2.0";
}>;

export type BrowserUseStartedSession = Readonly<{
  providerSessionId: string;
  liveUrl: string;
  cdpUrl: string;
}>;

export type BrowserUseUpstream = Readonly<{
  verifyCredentials(signal?: AbortSignal): Promise<BrowserUseUpstreamAttestation>;
  startSession(request: BrowserUseCloudV4Request, signal?: AbortSignal): Promise<BrowserUseStartedSession>;
  stopSession(
    providerSessionId: string,
    reason: "completed" | "failed" | "cancelled",
    signal?: AbortSignal,
  ): Promise<void>;
  reconcileSession(providerSessionId: string, signal?: AbortSignal): Promise<Readonly<{ terminated: true }>>;
}>;

export type AuthenticationObserverInput = Readonly<{
  targetOrigin: string;
  cdpUrl: string;
  signal: AbortSignal;
}>;

export type AuthenticationObserver = Readonly<{
  observe(input: AuthenticationObserverInput): Promise<AuthenticationSignal>;
}>;

export type CdpObserverInput = Readonly<{
  phase: "unauthenticated" | "authenticated";
  targetOrigin: string;
  sourceUrl: string;
  cdpUrl: string;
  allow(method: string, url: string): boolean;
  signal: AbortSignal;
}>;

export type CdpObserver = Readonly<{
  observe(input: CdpObserverInput): Promise<Readonly<{
    observations: WebsiteObservationInput;
    requiresAuthentication: boolean;
  }>>;
}>;

export type GatewayDependencies = Readonly<{
  clock?: () => Date;
  browserUseUpstream?: BrowserUseUpstream;
  egressEnforcer?: EgressEnforcer;
  ownershipVerifier?: OwnershipVerifier;
  authenticationObserver?: AuthenticationObserver;
  cdpObserver?: CdpObserver;
}>;
