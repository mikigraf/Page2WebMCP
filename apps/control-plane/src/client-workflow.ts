export type SourceType = "website" | "openapi" | "github";

export type PersistedWorkflow = {
  sourceType: SourceType;
  url: string;
  projectId?: string;
  analysisRunId?: string;
  workflowRunId?: string;
  releaseUrl?: string;
};

const WORKFLOW_KEY = "page2webmcp.workflow.v1";
const OPERATION_PREFIX = "page2webmcp.operation.v1.";

type OperationRecord = { requestBody: string; key: string };

export function loadWorkflow(storage: Storage): PersistedWorkflow | undefined {
  try {
    const raw = storage.getItem(WORKFLOW_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<PersistedWorkflow>;
    if (!isSourceType(value.sourceType) || typeof value.url !== "string" || value.url.length > 2_048) {
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

function isSourceType(value: unknown): value is SourceType {
  return value === "website" || value === "openapi" || value === "github";
}
