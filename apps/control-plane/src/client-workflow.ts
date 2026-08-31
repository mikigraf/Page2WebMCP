export type SourceType = "website" | "openapi" | "github";

export type SourceConfiguration =
  | { kind: "website" }
  | { kind: "github" }
  | {
    kind: "openapi";
    targetOrigin: string;
    testPageUrl: string;
    environment: "test" | "staging" | "production";
  };

export type PersistedWorkflow = {
  sourceType: SourceType;
  url: string;
  sourceConfiguration?: SourceConfiguration;
  projectId?: string;
  analysisRunId?: string;
  workflowRunId?: string;
  releaseUrl?: string;
};

export type AuthoritativeProjectWorkflow = Pick<PersistedWorkflow,
  "sourceType" | "url" | "sourceConfiguration" | "projectId" | "analysisRunId"> & {
  projectId: string;
};

const WORKFLOW_KEY = "page2webmcp.workflow.v1";
const OPERATION_PREFIX = "page2webmcp.operation.v1.";

type OperationRecord = { requestBody: string; key: string };

export function loadWorkflow(storage: Storage): PersistedWorkflow | undefined {
  try {
    const raw = storage.getItem(WORKFLOW_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<PersistedWorkflow>;
    if (!isSourceType(value.sourceType) || !isBoundedUrl(value.url)) {
      try { storage.removeItem(WORKFLOW_KEY); } catch { /* Ignore unavailable browser storage. */ }
      return undefined;
    }
    if (value.sourceConfiguration !== undefined && !isSourceConfiguration(value.sourceType, value.sourceConfiguration)) {
      try { storage.removeItem(WORKFLOW_KEY); } catch { /* Ignore unavailable browser storage. */ }
      return undefined;
    }
    for (const optional of [value.projectId, value.analysisRunId, value.workflowRunId, value.releaseUrl]) {
      if (optional !== undefined && typeof optional !== "string") {
        try { storage.removeItem(WORKFLOW_KEY); } catch { /* Ignore unavailable browser storage. */ }
        return undefined;
      }
    }
    return value as PersistedWorkflow;
  } catch {
    try { storage.removeItem(WORKFLOW_KEY); } catch { /* Ignore unavailable browser storage. */ }
    return undefined;
  }
}

export function saveWorkflow(storage: Storage, workflow: PersistedWorkflow): void {
  storage.setItem(WORKFLOW_KEY, JSON.stringify(workflow));
}

export function clearWorkflow(storage: Storage): void {
  storage.removeItem(WORKFLOW_KEY);
}

export function operationKey(
  storage: Storage,
  operation: string,
  requestBody: string,
  createKey: () => string = () => crypto.randomUUID()
): string {
  const storageKey = `${OPERATION_PREFIX}${encodeURIComponent(operation)}`;
  try {
    const raw = storage.getItem(storageKey);
    if (raw) {
      const current = JSON.parse(raw) as Partial<OperationRecord>;
      if (current.requestBody === requestBody && typeof current.key === "string" && current.key.length > 0) {
        return current.key;
      }
    }
  } catch {
    // Replace corrupt operation state below.
  }
  const key = createKey();
  storage.setItem(storageKey, JSON.stringify({ requestBody, key } satisfies OperationRecord));
  return key;
}

export function completeOperation(storage: Storage, operation: string, key: string): void {
  const storageKey = `${OPERATION_PREFIX}${encodeURIComponent(operation)}`;
  try {
    const current = JSON.parse(storage.getItem(storageKey) ?? "null") as Partial<OperationRecord> | null;
    if (current?.key === key) storage.removeItem(storageKey);
  } catch {
    storage.removeItem(storageKey);
  }
}

export function clearClientWorkflow(storage: Storage): void {
  clearWorkflow(storage);
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(OPERATION_PREFIX)) storage.removeItem(key);
  }
}

export function reconcileProjectWorkflow(
  recovered: PersistedWorkflow | undefined,
  authoritative: AuthoritativeProjectWorkflow
): PersistedWorkflow {
  const compatible = recovered?.projectId === authoritative.projectId
    && recovered.analysisRunId === authoritative.analysisRunId
    && recovered.sourceType === authoritative.sourceType
    && recovered.url === authoritative.url
    && sourceConfigurationMatches(recovered.sourceConfiguration, authoritative.sourceConfiguration);
  if (!compatible) return authoritative;
  return {
    ...authoritative,
    ...(recovered.workflowRunId ? { workflowRunId: recovered.workflowRunId } : {}),
    ...(recovered.releaseUrl ? { releaseUrl: recovered.releaseUrl } : {})
  };
}

function isSourceType(value: unknown): value is SourceType {
  return value === "website" || value === "openapi" || value === "github";
}

function isSourceConfiguration(sourceType: SourceType, value: unknown): value is SourceConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const configuration = value as Record<string, unknown>;
  if (configuration.kind !== sourceType) return false;
  if (sourceType !== "openapi") return Object.keys(configuration).length === 1;
  if (!isBoundedUrl(configuration.targetOrigin) || !isBoundedUrl(configuration.testPageUrl)
    || !["test", "staging", "production"].includes(String(configuration.environment))) return false;
  try {
    return new URL(String(configuration.targetOrigin)).origin === new URL(String(configuration.testPageUrl)).origin;
  } catch {
    return false;
  }
}

function sourceConfigurationMatches(left: SourceConfiguration | undefined, right: SourceConfiguration | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return left === right;
  return left.kind !== "openapi" || right.kind !== "openapi" || (
    left.targetOrigin === right.targetOrigin
    && left.testPageUrl === right.testPageUrl
    && left.environment === right.environment
  );
}

function isBoundedUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
