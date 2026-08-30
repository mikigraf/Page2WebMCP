import { createHash } from "node:crypto";

export type GitHubSandboxStep = "build" | "typecheck" | "test";

export type GitHubSandboxLimits = Readonly<{
  cpuCount: number;
  memoryBytes: number;
  timeoutMs: number;
  maxLogBytes: number;
  network: Readonly<{
    mode: "deny";
    packageCacheReferences: readonly string[];
  }>;
}>;

export type GitHubSandboxRequest = Readonly<{
  snapshotReference: string;
  patchDigest: string;
  baseCommitSha: string;
  limits: GitHubSandboxLimits;
  environment: Readonly<Record<string, never>>;
  steps: readonly GitHubSandboxStep[];
  signal: AbortSignal;
}>;

export type GitHubSandboxPort = Readonly<{
  run(input: GitHubSandboxRequest): Promise<Readonly<{
    snapshotReference: string;
    patchDigest: string;
    baseCommitSha: string;
    appliedLimits: GitHubSandboxLimits;
    environmentKeys: readonly string[];
    networkAttempts: readonly string[];
    steps: ReadonlyArray<Readonly<{ step: string; exitCode: number; log: string }>>;
  }>>;
}>;

export type GitHubSandboxVerification = Readonly<{
  version: 1;
  snapshotReference: string;
  patchDigest: string;
  baseCommitSha: string;
  passed: boolean;
  steps: ReadonlyArray<Readonly<{ step: GitHubSandboxStep; exitCode: number; log: string }>>;
  reference: string;
}>;

const requiredSteps: readonly GitHubSandboxStep[] = ["build", "typecheck", "test"];

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function validateLimits(limits: GitHubSandboxLimits): void {
  if (!limits || !Number.isInteger(limits.cpuCount) || limits.cpuCount < 1 || limits.cpuCount > 4
    || !Number.isInteger(limits.memoryBytes) || limits.memoryBytes < 256 * 1_024 * 1_024 || limits.memoryBytes > 4 * 1_024 * 1_024 * 1_024
    || !Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1_000 || limits.timeoutMs > 10 * 60_000
    || !Number.isInteger(limits.maxLogBytes) || limits.maxLogBytes < 1_024 || limits.maxLogBytes > 64 * 1_024
    || limits.network?.mode !== "deny" || !Array.isArray(limits.network.packageCacheReferences)
    || limits.network.packageCacheReferences.length > 16
    || limits.network.packageCacheReferences.some((reference) => !/^cache:[A-Za-z0-9._-]{1,160}$/.test(reference))
    || new Set(limits.network.packageCacheReferences).size !== limits.network.packageCacheReferences.length) {
    throw new Error("GITHUB_SANDBOX_POLICY_INVALID");
  }
}

function sanitizeLog(value: string): string {
  return value
    .replace(/\bgh[pousr]_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-(?:live|test|proj|service|admin)-[A-Za-z0-9_-]{6,}\b/gi, "[REDACTED_API_KEY]")
    .replace(/\b(?:DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY|GITHUB_TOKEN)\s*=\s*\S+/gi, "[REDACTED_ENVIRONMENT_VALUE]")
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/\S+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/\b(?:bearer|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED_CREDENTIAL]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[REDACTED]@");
}

function abortPromise(signal: AbortSignal): { promise: Promise<never>; cleanup(): void } {
  let rejectAbort!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new Error("GITHUB_SANDBOX_CANCELLED"));
  signal.addEventListener("abort", abort, { once: true });
  return { promise, cleanup: () => signal.removeEventListener("abort", abort) };
}

export async function runGitHubSandboxVerification(
  input: Readonly<{
    snapshotReference: string;
    patchDigest: string;
    baseCommitSha: string;
    limits: GitHubSandboxLimits;
  }>,
  port: GitHubSandboxPort,
  signal: AbortSignal = new AbortController().signal,
): Promise<GitHubSandboxVerification> {
  validateLimits(input.limits);
  if (!/^urn:sha256:[a-f0-9]{64}$/.test(input.snapshotReference)
    || !/^[a-f0-9]{64}$/.test(input.patchDigest)
    || !/^[a-f0-9]{40}$/.test(input.baseCommitSha)
    || !port?.run) throw new Error("GITHUB_SANDBOX_INPUT_INVALID");
  if (signal.aborted) throw new Error("GITHUB_SANDBOX_CANCELLED");
  const request: GitHubSandboxRequest = {
    ...input,
    limits: structuredClone(input.limits),
    environment: Object.freeze({}),
    steps: requiredSteps,
    signal,
  };
  const cancellation = abortPromise(signal);
  let response: Awaited<ReturnType<GitHubSandboxPort["run"]>>;
  try {
    response = await Promise.race([port.run(request), cancellation.promise]);
  } finally {
    cancellation.cleanup();
  }
  if (response.snapshotReference !== input.snapshotReference || response.patchDigest !== input.patchDigest
    || response.baseCommitSha !== input.baseCommitSha
    || canonicalJson(response.appliedLimits) !== canonicalJson(input.limits)) {
    throw new Error("GITHUB_SANDBOX_ATTESTATION_MISMATCH");
  }
  if (!Array.isArray(response.environmentKeys) || response.environmentKeys.length !== 0) {
    throw new Error("GITHUB_SANDBOX_CREDENTIALS_PRESENT");
  }
  if (!Array.isArray(response.networkAttempts) || response.networkAttempts.length !== 0) {
    throw new Error("GITHUB_SANDBOX_NETWORK_VIOLATION");
  }
  if (!Array.isArray(response.steps)) throw new Error("GITHUB_SANDBOX_RESULT_INVALID");
  let logBytes = 0;
  for (const step of response.steps) {
    if (typeof step.log !== "string") throw new Error("GITHUB_SANDBOX_RESULT_INVALID");
    logBytes += Buffer.byteLength(step.log, "utf8");
    if (logBytes > input.limits.maxLogBytes) throw new Error("GITHUB_SANDBOX_LOG_LIMIT_EXCEEDED");
  }
  if (response.steps.length !== requiredSteps.length
    || response.steps.some((step, index) => step.step !== requiredSteps[index]
      || !Number.isSafeInteger(step.exitCode) || step.exitCode < 0 || step.exitCode > 255)) {
    throw new Error("GITHUB_SANDBOX_RESULT_INVALID");
  }
  const steps = response.steps.map((step, index) => ({
    step: requiredSteps[index]!,
    exitCode: step.exitCode,
    log: sanitizeLog(step.log),
  }));
  const evidence = {
    version: 1 as const,
    snapshotReference: input.snapshotReference,
    patchDigest: input.patchDigest,
    baseCommitSha: input.baseCommitSha,
    passed: steps.every(({ exitCode }) => exitCode === 0),
    steps,
  };
  return {
    ...evidence,
    reference: `urn:sha256:${createHash("sha256").update(canonicalJson(evidence), "utf8").digest("hex")}`,
  };
}
