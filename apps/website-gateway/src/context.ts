import type { GatewayConfiguration } from "./config.ts";
import type {
  AuthenticationObserver,
  BrowserUseUpstream,
  CdpObserver,
} from "./dependencies.ts";
import type { CheckpointStore } from "./stores/checkpoints.ts";
import type { EgressEnforcer } from "./stores/enforcement.ts";
import type { EvidenceStore } from "./stores/evidence.ts";
import type { LeaseStore } from "./stores/leases.ts";
import type { OwnershipStore, OwnershipVerifier, ReplayStore } from "./stores/ownership.ts";
import type { PolicyStore } from "./stores/policies.ts";
import type { SecretStore } from "./stores/secrets.ts";

export type GatewayContext = Readonly<{
  configuration: GatewayConfiguration;
  clock: () => Date;
  checkpoints: CheckpointStore;
  enforcer: EgressEnforcer;
  evidence: EvidenceStore;
  leases: LeaseStore;
  ownership: OwnershipStore;
  policies: PolicyStore;
  replays: ReplayStore;
  secrets?: SecretStore;
  browserUseUpstream?: BrowserUseUpstream;
  ownershipVerifier?: OwnershipVerifier;
  authenticationObserver?: AuthenticationObserver;
  cdpObserver?: CdpObserver;
}>;

/** True when this process also serves the named control, so it may consult it directly. */
export function colocated(context: GatewayContext, control: Parameters<GatewayContext["configuration"]["controls"]["has"]>[0]): boolean {
  return context.configuration.controls.has(control);
}
