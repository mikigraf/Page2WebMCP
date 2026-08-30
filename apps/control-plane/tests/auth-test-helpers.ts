import type { RepositoryActor } from "../../../packages/database/src/control-plane.ts";
import { InMemoryControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { setControlPlaneRepositoryForTest } from "../../../packages/database/src/factory.ts";
import { issueCsrfChallenge } from "../src/api.ts";
import { setAuthServiceForTest } from "../src/auth.ts";
import {
  authenticate,
  createFixtureAuthService,
  fixtureSessionId,
  issueSession
} from "../src/auth-fixture.ts";

export const TEST_CSRF_SECRET = "test-control-plane-csrf-secret-at-least-32-bytes";
process.env.PAGE2WEBMCP_SESSION_SECRET = TEST_CSRF_SECRET;

export const owner = authenticate("owner@example.test", "fixture-password")!;
export const editor = authenticate("editor@example.test", "fixture-password")!;
export const viewer = authenticate("viewer@example.test", "fixture-password")!;

setAuthServiceForTest(createFixtureAuthService());

export function installTestRepository(repository = new InMemoryControlPlaneRepository()): InMemoryControlPlaneRepository {
  repository.seedMembershipForTest(owner);
  repository.seedMembershipForTest(editor);
  repository.seedMembershipForTest(viewer);
  setControlPlaneRepositoryForTest(repository);
  setAuthServiceForTest(createFixtureAuthService());
  return repository;
}

export function authenticatedHeaders(
  actor: RepositoryActor,
  origin = "https://control.example"
): Record<string, string> {
  const token = issueSession(actor);
  const sessionId = fixtureSessionId(token)!;
  const challenge = issueCsrfChallenge(new Request(`${origin}/api/auth/csrf`), {
    secret: TEST_CSRF_SECRET,
    sessionId
  });
  return {
    cookie: `page2webmcp_fixture_session=${token}; ${challenge.cookie.split(";")[0]}`,
    origin,
    "sec-fetch-site": "same-origin",
    "x-csrf-token": challenge.token
  };
}

export function anonymousCsrfHeaders(origin = "http://test"): Record<string, string> {
  const challenge = issueCsrfChallenge(new Request(`${origin}/api/auth/csrf`), { secret: TEST_CSRF_SECRET });
  return {
    cookie: challenge.cookie.split(";")[0]!,
    origin,
    "sec-fetch-site": "same-origin",
    "x-csrf-token": challenge.token
  };
}
