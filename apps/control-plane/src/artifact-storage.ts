import { createHash } from "node:crypto";
import { createClient, StorageApiError } from "@supabase/supabase-js";

const RELEASE_BUCKET = "page2webmcp-releases";
const MAX_CANDIDATE_BYTES = 65_536;
const PUBLIC_READ_BUDGET = 3;
const PUBLICATION_DEADLINE_MS = 30_000;
const HOSTED_SUPABASE_URL = "https://bimqgiedckdurqiywctl.supabase.co";
const HOSTED_PUBLIC_ORIGIN = `${HOSTED_SUPABASE_URL}/storage/v1/object/public/${RELEASE_BUCKET}`;
const LOCAL_SUPABASE_URL = "http://127.0.0.1:58321";
const LOCAL_PUBLIC_ORIGIN = `${LOCAL_SUPABASE_URL}/storage/v1/object/public/${RELEASE_BUCKET}`;
const HASH = /^[0-9a-f]{64}$/;
const SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;

type RuntimeEnvironment = Record<string, string | undefined>;
type UploadOptions = Readonly<{ contentType: string; cacheControl: string; upsert: boolean }>;
type UploadResult = Readonly<{ data: unknown; error: null } | { data: null; error: unknown }>;

export type ReleaseArtifactStorageClient = Readonly<{
  storage: Readonly<{
    from(bucket: string): Readonly<{
      upload(path: string, body: Uint8Array, options: UploadOptions): Promise<UploadResult>;
    }>;
  }>;
}>;

export type ReleaseArtifactClientOptions = Readonly<{
  auth: Readonly<{ persistSession: false; autoRefreshToken: false; detectSessionInUrl: false }>;
  global: Readonly<{ fetch: typeof fetch }>;
}>;

export type ReleaseArtifactClientFactory = (
  server: string,
  secret: string,
  options: ReleaseArtifactClientOptions,
) => ReleaseArtifactStorageClient;

export type ReleaseArtifactPublication = Readonly<{
  artifactUrl: string;
  downloadUrl: string;
  contentHash: string;
  integrity: string;
  localOnly: boolean;
}>;

export interface ReleaseArtifactStore {
  publish(input: Readonly<{
    code: string;
    contentHash: string;
    integrity: string;
    targetOrigin: string;
  }>, signal: AbortSignal): Promise<ReleaseArtifactPublication>;
}

let testStore: ReleaseArtifactStore | undefined;

export function setReleaseArtifactStoreForTest(store: ReleaseArtifactStore | undefined): void {
  if (process.env.NODE_ENV === "production") throw new Error("TEST_ADAPTER_FORBIDDEN");
  testStore = store;
}

export function releaseArtifactStore(): ReleaseArtifactStore {
  return testStore ?? createConfiguredReleaseArtifactStore(process.env);
}

export type ReleaseArtifactStoreDependencies = Readonly<{
  createClient?: ReleaseArtifactClientFactory;
  fetch?: typeof fetch;
  deadlineMs?: number;
}>;

type ArtifactTopology = Readonly<{
  server: string;
  secret: string;
  publicOrigin: string;
  localOnly: boolean;
}>;

type PublicationLifecycle = Readonly<{
  signal: AbortSignal;
  callerSignal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}>;

class ReleaseArtifactError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "Error";
  }
}

export function validateReleaseArtifactStorageConfiguration(environment: RuntimeEnvironment): ArtifactTopology {
  for (const [name, value] of Object.entries(environment)) {
    if (!value || name === "PAGE2WEBMCP_SUPABASE_SECRET_KEY") continue;
    if (name.startsWith("NEXT_PUBLIC_PAGE2WEBMCP_SUPABASE_")
      || /SUPABASE_(?:SERVICE_ROLE(?:_KEY)?|SECRET(?:_KEY)?)$/.test(name)) {
      throw stableError("RELEASE_ARTIFACT_SECRET_EXPOSURE_BLOCKED");
    }
  }

  const server = environment.PAGE2WEBMCP_SUPABASE_URL;
  const secret = environment.PAGE2WEBMCP_SUPABASE_SECRET_KEY;
  const publicOrigin = environment.PAGE2WEBMCP_PUBLIC_ORIGIN;
  if (!secret || secret.length < 32 || secret.length > 4_096 || secret.trim() !== secret || /[\r\n]/.test(secret)) {
    throw stableError("RELEASE_ARTIFACT_CONFIGURATION_REQUIRED");
  }
  if (environment.PAGE2WEBMCP_LOCAL_STACK !== "true"
    && server === HOSTED_SUPABASE_URL && publicOrigin === HOSTED_PUBLIC_ORIGIN) {
    return { server, secret, publicOrigin, localOnly: false };
  }
  if (environment.PAGE2WEBMCP_LOCAL_STACK === "true"
    && server === LOCAL_SUPABASE_URL && publicOrigin === LOCAL_PUBLIC_ORIGIN) {
    return { server, secret, publicOrigin, localOnly: true };
  }
  throw stableError("RELEASE_ARTIFACT_CONFIGURATION_REQUIRED");
}

export function createConfiguredReleaseArtifactStore(
  environment: RuntimeEnvironment = process.env,
  dependencies: ReleaseArtifactStoreDependencies = {},
): ReleaseArtifactStore {
  const topology = validateReleaseArtifactStorageConfiguration(environment);
  const clientFactory = dependencies.createClient ?? defaultClientFactory;
  const transport = dependencies.fetch ?? fetch;
  const deadlineMs = dependencies.deadlineMs ?? PUBLICATION_DEADLINE_MS;
  if (typeof clientFactory !== "function" || typeof transport !== "function"
    || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PUBLICATION_DEADLINE_MS) {
    throw stableError("RELEASE_ARTIFACT_CONFIGURATION_REQUIRED");
  }

  return {
    async publish(input, signal) {
      const candidate = validateCandidate(input);
      if (!(signal instanceof AbortSignal)) throw stableError("RELEASE_ARTIFACT_INPUT_INVALID");
      if (signal.aborted) throw stableError("RELEASE_ARTIFACT_ABORTED");
      const lifecycle = createPublicationLifecycle(signal, deadlineMs);
      if (lifecycle.signal.aborted) {
        lifecycle.dispose();
        throw lifecycleError(lifecycle);
      }
      const boundedFetch: typeof fetch = async (resource, init) => {
        try {
          return await raceWithLifecycle(
            transport(resource, { ...init, signal: lifecycle.signal }),
            lifecycle,
          );
        } catch (error) {
          if (lifecycle.signal.aborted) throw lifecycleError(lifecycle);
          throw error;
        }
      };
      const uploadUrl = `${topology.server}/storage/v1/object/${RELEASE_BUCKET}/${candidate.contentHash}.js`;
      const uploadFetch = createUploadFetch(boundedFetch, uploadUrl, lifecycle);
      try {
        let client: ReleaseArtifactStorageClient;
        try {
          client = clientFactory(topology.server, topology.secret, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            global: { fetch: uploadFetch },
          });
        } catch {
          throw stableError("RELEASE_ARTIFACT_UPLOAD_FAILED");
        }
        let upload: UploadResult;
        try {
          upload = await raceWithLifecycle(client.storage.from(RELEASE_BUCKET).upload(
            `${candidate.contentHash}.js`,
            candidate.bytes,
            { contentType: "application/javascript", cacheControl: "31536000", upsert: false },
          ), lifecycle);
        } catch (error) {
          if (error instanceof ReleaseArtifactError) throw error;
          if (lifecycle.signal.aborted) throw lifecycleError(lifecycle);
          if (!isAmbiguousUploadResponseLoss(error)) throw stableError("RELEASE_ARTIFACT_UPLOAD_FAILED");
          upload = { data: null, error };
        }
        if (lifecycle.signal.aborted) throw lifecycleError(lifecycle);
        if (upload.error !== null && !isObjectExists(upload.error)
          && !isAmbiguousUploadResponseLoss(upload.error)) {
          throw stableError("RELEASE_ARTIFACT_UPLOAD_FAILED");
        }
        if (upload.error === null && upload.data === null) {
          throw stableError("RELEASE_ARTIFACT_UPLOAD_FAILED");
        }

        const artifactUrl = `${topology.publicOrigin}/${candidate.contentHash}.js`;
        const downloadUrl = `${artifactUrl}?download=page2webmcp-${candidate.contentHash}.js`;
        const budget = { remaining: PUBLIC_READ_BUDGET };
        await verifyPublicIdentity(boundedFetch, artifactUrl, candidate, false, budget, lifecycle);
        await verifyPublicIdentity(boundedFetch, downloadUrl, candidate, true, budget, lifecycle);
        return {
          artifactUrl,
          downloadUrl,
          contentHash: candidate.contentHash,
          integrity: candidate.integrity,
          localOnly: topology.localOnly,
        };
      } catch (error) {
        if (error instanceof ReleaseArtifactError) throw error;
        if (lifecycle.signal.aborted) throw lifecycleError(lifecycle);
        throw stableError("RELEASE_ARTIFACT_UPLOAD_FAILED");
      } finally {
        lifecycle.dispose();
      }
    },
  };
}

function createUploadFetch(
  transport: typeof fetch,
  expectedUrl: string,
  lifecycle: PublicationLifecycle,
): typeof fetch {
  return async (resource, init) => {
    const requestedUrl = requestUrl(resource);
    const requestedMethod = init?.method ?? (resource instanceof Request ? resource.method : "GET");
    if (requestedUrl !== expectedUrl || requestedMethod !== "POST") {
      throw stableError("RELEASE_ARTIFACT_UPLOAD_FAILED");
    }
    const response = await transport(resource, {
      ...init,
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: lifecycle.signal,
    });
    if (response.url !== expectedUrl || response.redirected
      || response.status >= 300 && response.status <= 399) {
      await cancelResponseBody(response, lifecycle, "RELEASE_ARTIFACT_UPLOAD_FAILED");
      throw stableError("RELEASE_ARTIFACT_UPLOAD_FAILED");
    }
    return response;
  };
}

const defaultClientFactory: ReleaseArtifactClientFactory = (server, secret, options) =>
  createClient(server, secret, options) as ReleaseArtifactStorageClient;

function validateCandidate(input: Readonly<{
  code: string;
  contentHash: string;
  integrity: string;
  targetOrigin: string;
}>): Readonly<{ bytes: Buffer; contentHash: string; integrity: string }> {
  if (!input || typeof input.code !== "string" || typeof input.contentHash !== "string"
    || typeof input.integrity !== "string" || typeof input.targetOrigin !== "string") {
    throw stableError("RELEASE_ARTIFACT_INPUT_INVALID");
  }
  const bytes = Buffer.from(input.code, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_CANDIDATE_BYTES
    || !HASH.test(input.contentHash) || !SRI.test(input.integrity)
    || exactHttpsOrigin(input.targetOrigin) !== input.targetOrigin
    || sha256(bytes) !== input.contentHash || sha384(bytes) !== input.integrity) {
    throw stableError("RELEASE_ARTIFACT_INPUT_INVALID");
  }
  return { bytes, contentHash: input.contentHash, integrity: input.integrity };
}

async function verifyPublicIdentity(
  transport: typeof fetch,
  expectedUrl: string,
  candidate: Readonly<{ bytes: Buffer; contentHash: string; integrity: string }>,
  download: boolean,
  budget: { remaining: number },
  lifecycle: PublicationLifecycle,
): Promise<void> {
  for (;;) {
    if (budget.remaining <= 0) throw stableError("RELEASE_ARTIFACT_READ_FAILED");
    budget.remaining -= 1;
    let response: Response;
    try {
      response = await transport(expectedUrl, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: lifecycle.signal,
      });
    } catch (error) {
      if (error instanceof ReleaseArtifactError) throw error;
      if (lifecycle.signal.aborted) throw lifecycleError(lifecycle);
      throw stableError("RELEASE_ARTIFACT_READ_FAILED");
    }
    if (response.url !== expectedUrl || response.redirected || response.headers.has("set-cookie")) {
      await cancelResponseBody(response, lifecycle, "RELEASE_ARTIFACT_MISMATCH");
      throw stableError("RELEASE_ARTIFACT_MISMATCH");
    }
    if (transientReadStatus(response.status)) {
      await cancelResponseBody(response, lifecycle, "RELEASE_ARTIFACT_READ_FAILED");
      if (budget.remaining <= 0) throw stableError("RELEASE_ARTIFACT_READ_FAILED");
      continue;
    }
    if (response.status !== 200) {
      await cancelResponseBody(response, lifecycle, "RELEASE_ARTIFACT_READ_FAILED");
      throw stableError("RELEASE_ARTIFACT_READ_FAILED");
    }
    if (mediaType(response.headers.get("content-type")) !== "application/javascript"
      || download && !validDownloadDisposition(response.headers.get("content-disposition"), candidate.contentHash)) {
      await cancelResponseBody(response, lifecycle, "RELEASE_ARTIFACT_MISMATCH");
      throw stableError("RELEASE_ARTIFACT_MISMATCH");
    }
    let bytes: Buffer;
    try {
      bytes = await readBoundedBody(response, lifecycle);
    } catch (error) {
      if (error instanceof ReleaseArtifactError) throw error;
      if (lifecycle.signal.aborted) throw lifecycleError(lifecycle);
      throw stableError("RELEASE_ARTIFACT_READ_FAILED");
    }
    if (!bytes.equals(candidate.bytes) || sha256(bytes) !== candidate.contentHash
      || sha384(bytes) !== candidate.integrity) {
      throw stableError("RELEASE_ARTIFACT_MISMATCH");
    }
    return;
  }
}

async function readBoundedBody(response: Response, lifecycle: PublicationLifecycle): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_CANDIDATE_BYTES)) {
    await cancelResponseBody(response, lifecycle, "RELEASE_ARTIFACT_MISMATCH");
    throw stableError("RELEASE_ARTIFACT_MISMATCH");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await raceWithLifecycle(reader.read(), lifecycle);
      if (part.done) break;
      const bytes = Buffer.from(part.value);
      length += bytes.byteLength;
      if (length > MAX_CANDIDATE_BYTES) {
        throw stableError("RELEASE_ARTIFACT_MISMATCH");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    await cancelReader(reader, lifecycle);
    if (lifecycle.signal.aborted) throw lifecycleError(lifecycle);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* cancellation may settle a pending read asynchronously */ }
  }
  return Buffer.concat(chunks, length);
}

function createPublicationLifecycle(callerSignal: AbortSignal, deadlineMs: number): PublicationLifecycle {
  const controller = new AbortController();
  let timeoutReached = false;
  const onCallerAbort = () => controller.abort();
  callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal.aborted) controller.abort();
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, deadlineMs);
  return {
    signal: controller.signal,
    callerSignal,
    timedOut: () => timeoutReached,
    dispose() {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", onCallerAbort);
    },
  };
}

async function raceWithLifecycle<T>(operation: Promise<T>, lifecycle: PublicationLifecycle): Promise<T> {
  if (lifecycle.signal.aborted) {
    void operation.catch(() => undefined);
    throw lifecycleError(lifecycle);
  }
  let removeAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(lifecycleError(lifecycle));
    lifecycle.signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => lifecycle.signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbort();
  }
}

function lifecycleError(lifecycle: PublicationLifecycle): ReleaseArtifactError {
  return stableError(lifecycle.callerSignal.aborted
    ? "RELEASE_ARTIFACT_ABORTED"
    : lifecycle.timedOut()
      ? "RELEASE_ARTIFACT_DEADLINE_EXCEEDED"
      : "RELEASE_ARTIFACT_ABORTED");
}

function isObjectExists(error: unknown): boolean {
  if (!(error instanceof StorageApiError) || error.status !== 400 && error.status !== 409) return false;
  if (error.code === "ResourceAlreadyExists" || error.code === "KeyAlreadyExists"
    || error.statusCode === "ResourceAlreadyExists" || error.statusCode === "KeyAlreadyExists") return true;
  return error.status === 400 && error.code === undefined && error.statusCode === "409";
}

function isAmbiguousUploadResponseLoss(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "StorageUnknownError") {
    const original = (error as Error & { originalError?: unknown }).originalError;
    return isFetchResponseLoss(original);
  }
  return isFetchResponseLoss(error);
}

function isFetchResponseLoss(error: unknown): boolean {
  if (!(error instanceof TypeError) || error.message !== "fetch failed") return false;
  const cause = (error as TypeError & { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return false;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && [
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_SOCKET",
  ].includes(code);
}

function transientReadStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;
}

function mediaType(value: string | null): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function validDownloadDisposition(value: string | null, contentHash: string): boolean {
  if (!value || /[\r\n]/.test(value)) return false;
  const expected = `page2webmcp-${contentHash}.js`;
  const match = /^attachment\s*;\s*filename=(?:"([^"]+)"|([A-Za-z0-9.-]+))(?:\s*;\s*filename\*=UTF-8''([A-Za-z0-9.-]+))?\s*$/i.exec(value);
  return (match?.[1] ?? match?.[2]) === expected
    && (match?.[3] === undefined || match[3] === expected);
}

async function cancelResponseBody(
  response: Response,
  lifecycle: PublicationLifecycle,
  failureCode: string,
): Promise<void> {
  if (!response.body) return;
  let cancellation: Promise<void>;
  try {
    cancellation = response.body.cancel();
  } catch {
    throw stableError(failureCode);
  }
  try {
    await raceWithLifecycle(cancellation, lifecycle);
  } catch (error) {
    if (lifecycle.signal.aborted) throw lifecycleError(lifecycle);
    if (error instanceof ReleaseArtifactError) throw error;
    throw stableError(failureCode);
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  lifecycle: PublicationLifecycle,
): Promise<void> {
  let cancellation: Promise<void>;
  try {
    cancellation = reader.cancel();
  } catch {
    return;
  }
  if (lifecycle.signal.aborted) {
    void cancellation.catch(() => undefined);
    return;
  }
  try {
    await raceWithLifecycle(cancellation, lifecycle);
  } catch {
    void cancellation.catch(() => undefined);
  }
}

function requestUrl(resource: RequestInfo | URL): string | undefined {
  if (typeof resource === "string") return resource;
  if (resource instanceof URL) return resource.toString();
  if (resource instanceof Request) return resource.url;
  return undefined;
}

function exactHttpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && !url.search && !url.hash && url.origin === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha384(bytes: Uint8Array): string {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

function stableError(code: string): ReleaseArtifactError {
  return new ReleaseArtifactError(code);
}
