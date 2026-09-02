import { createHash, timingSafeEqual } from "node:crypto";

export type OperatorCredentials = Readonly<{ email: string; password: string }>;

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Reads the single operator identity from configuration. Returns `null` when the
 * deployment has no usable credentials so that every login fails closed.
 */
export function parseOperatorCredentials(
  environment: Record<string, string | undefined>,
): OperatorCredentials | null {
  const email = environment.PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_EMAIL;
  const password = environment.PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_PASSWORD;
  if (!email || !password) return null;
  if (email.trim() !== email || email.length > 254 || !EMAIL.test(email)) return null;
  if (password.trim() !== password
    || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) return null;
  return { email, password };
}

/** Constant-time comparison over fixed-width digests of the two secrets. */
export function secretsMatch(candidate: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}
