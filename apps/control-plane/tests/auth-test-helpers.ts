import type { RepositoryActor } from "../../../packages/database/src/control-plane.ts";
import { InMemoryControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { setControlPlaneRepositoryForTest } from "../../../packages/database/src/factory.ts";
import { issueCsrfChallenge } from "../src/api.ts";
import {
  setReleaseArtifactStoreForTest,
  type ReleaseArtifactStore,
} from "../src/artifact-storage.ts";
import { setAuthServiceForTest } from "../src/auth.ts";
import {
  REQUIRED_CANDIDATE_CHECKS,
  setReleaseVerificationPortForTest,
  type ReleaseVerificationPort,
} from "../src/release-verification.ts";
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

export const hermeticReleaseVerificationPort: ReleaseVerificationPort = {
  mode: "hermetic",
  verifyCandidate: async (input) => ({
    observedContentHash: input.contentHash,
    observedIntegrity: input.integrity,
    observedReleaseId: input.manifest.releaseId,
    observedTargetOrigin: input.targetOrigin,
    registeredTools: [...input.expectedTools],
    trustedLoader: { enforcedBeforeEvaluation: true, evaluatedContentHash: input.contentHash },
    controlPlaneRequestsDuringExecution: 0,
    modelRequestsDuringExecution: 0,
    checks: REQUIRED_CANDIDATE_CHECKS.map((name) => ({ name, status: "passed" as const })),
    csp: { hosted: "allowed" as const },
  }),
  verifyInstalled: async (input) => ({
    observedArtifactUrl: input.artifactUrl,
    observedDownloadUrl: input.downloadUrl,
    observedLocalOnly: input.localOnly,
    observedIntegrity: input.integrity,
    executedArtifactUrl: input.selfHostedUrl ?? input.artifactUrl,
    servedContentHash: input.contentHash,
    executedContentHash: input.contentHash,
    observedTargetOrigin: input.targetOrigin,
    registeredTools: [...input.expectedTools],
    webMcpImplementation: "native",
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    csp: { hosted: "allowed" as const },
  }),
};

export const hermeticReleaseArtifactStore: ReleaseArtifactStore = {
  publish: async (input) => {
    const artifactUrl =
      `https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/${input.contentHash}.js`;
    return {
      artifactUrl,
      downloadUrl: `${artifactUrl}?download=page2webmcp-${input.contentHash}.js`,
      contentHash: input.contentHash,
      integrity: input.integrity,
      localOnly: false,
    };
  },
};

setAuthServiceForTest(createFixtureAuthService());

export function installTestRepository(repository = new InMemoryControlPlaneRepository()): InMemoryControlPlaneRepository {
  repository.seedMembershipForTest(owner);
  repository.seedMembershipForTest(editor);
  repository.seedMembershipForTest(viewer);
  setControlPlaneRepositoryForTest(repository);
  setAuthServiceForTest(createFixtureAuthService());
  setReleaseVerificationPortForTest(hermeticReleaseVerificationPort);
  setReleaseArtifactStoreForTest(hermeticReleaseArtifactStore);
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
