export const GATEWAY_PROTOCOL_VERSION = 1 as const;
export const AUTHENTICATION_CHECKPOINT_PROTOCOL_VERSION = 1 as const;
export const AUTHENTICATION_USER_HANDOFF_PROTOCOL_VERSION = 1 as const;
export const SOURCE_ATTESTATION_PROTOCOL_VERSION = 1 as const;

export const MAX_CONTROL_BYTES = 64 * 1_024;
export const MAX_SESSION_TTL_MS = 10 * 60_000;
export const MAX_POLICY_TTL_MS = 10 * 60_000;
export const MAX_SECRET_TTL_MS = 10 * 60_000;
export const MAX_LEASE_TTL_MS = 10 * 60_000;
export const MAX_OWNERSHIP_CHALLENGE_TTL_MS = 15 * 60_000;
export const UPSTREAM_TIMEOUT_MS = 10_000;
export const AUTH_SIGNAL_MAX_AGE_MS = 5 * 60_000;

export const HEX64 = /^[0-9a-f]{64}$/;
export const SECRET_REFERENCE = /^secretref:[A-Za-z0-9._:-]{1,200}$/;
export const HASH_REFERENCE = /^urn:sha256:[0-9a-f]{64}$/;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,256}$/;
export const HANDOFF_PARAMETER = /^[A-Za-z0-9._~-]{1,128}$/;
export const CHALLENGE_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

export const CONTROL_NAMES = Object.freeze([
  "authentication-handoff",
  "browser-lease-store",
  "browser-use-v4",
  "cdp-observer",
  "egress-policy-store",
  "egress-proxy",
  "evidence-store",
  "ownership-store",
  "ttl-secret-store",
] as const);

export type ControlName = typeof CONTROL_NAMES[number];

export const ALLOWED_AUTH_SIGNALS = Object.freeze(
  new Set(["account_control", "authenticated_status", "logout_control"]),
);

export const SECRET_PURPOSES = Object.freeze(
  new Set(["browser_live_url", "browser_cdp_url"]),
);
