import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import {
  canonicalizeCapabilityPlans,
  type CapabilityPlan,
} from "../../capability-ir/src/plan.ts";
import {
  capabilityPlanDigest,
  capabilityStateDigest,
  gitHubDraftPullRequestMatchesRequest,
  normalizeAnalysisDiagnostics,
  normalizeAnalysisSourceTypes,
  normalizeProviderProvenance,
  parsePersistedSourceConfiguration,
  normalizeSourceConfiguration,
  normalizeReleaseArtifactIdentity,
  normalizeReleaseInstallation,
  normalizeGitHubDraftPullRequest,
  persistedReleaseArtifactIdentity,
  releaseFailures,
  RepositoryError,
  type AnalysisResult,
  type AnalysisEvidence,
  type AnalysisRunRecord,
  type AuditEventRecord,
  type CandidateRelease,
  type CapabilityRecord,
  type ClaimedAnalysisRunRecord,
  type ControlPlaneRepository,
  type CreateProjectRequest,
  type EnqueueAnalysisRequest,
  type AuthenticatedIdentity,
  type IdempotentRequest,
  type GitHubDraftPullRequestRecord,
  type ProjectPage,
  type ProjectPageRequest,
  type ProjectRecord,
  type PublishedReleaseState,
  type PublishRequest,
  type ReleaseRecord,
  type ReleaseInstallationRecord,
  type ReleaseInstallationRequest,
  type SaveGitHubDraftPullRequestRequest,
  type RepositoryActor,
  type ReviewInput,
  type SourceType,
  type VerificationRecord,
  type VerificationRequest,
  type WaitAnalysisForAuthenticationInput,
  type WebsiteAuthenticationCheckpointRecord,
  type WorkflowExecutionMaterial,
  type ResumeAnalysisAfterAuthenticationInput,
} from "./control-plane.ts";
import { computeSourceIdentityHash } from "./source-identity.ts";
import {
  WORKFLOW_DEFAULT_ACTIVE_TASK_QUOTA,
  WORKFLOW_LEASE_MS,
  workflowPhase,
  workflowRetryDelayMs,
  type CancelWorkflowInput,
  type ClaimedWorkflowTaskRecord,
  type CompleteWorkflowTaskInput,
  type FailWorkflowTaskInput,
  type ProjectSourceRecord,
  type ResumeWorkflowTaskInput,
  type SourceSnapshotRecord,
  type StartWorkflowInput,
  type WaitWorkflowTaskInput,
  type WorkflowCapabilityPlanLink,
  type WorkflowEventRecord,
  type WorkflowEvidenceLink,
  type WorkflowRunRecord,
  type WorkflowTaskCompletion,
  type WorkflowTaskEventInput,
  type WorkflowTaskRecord,
  type SourceConfiguration,
} from "./workflow.ts";

type PostgresOptions = {
  connectionString: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  pool?: pg.Pool;
  writeLog?: (line: string) => void;
  random?: () => number;
  activeTaskQuota?: number;
};
type Db = Pick<PoolClient, "query">;
type ExecutionContext =
  | { kind: "app"; actor: RepositoryActor }
  | { kind: "identity"; identityId: string }
  | { kind: "artifact" }
  | { kind: "worker" };

const MAX_PROJECT_PAGE_SIZE = 100;
const MAX_CAPABILITIES = 1_000;
const MAX_EVIDENCE = 1_000;
const MAX_AUDIT_EVENTS = 1_000;
const MAX_RELEASE_BYTES = 64 * 1_024;
const RELEASE_INSTALLATION_COLUMNS =
  "id, organization_id, project_id, release_id, actor_id, page_url, artifact_url, self_hosted_url, " +
  "target_origin, artifact_content_hash, integrity, expected_tools, status, delivery, csp_status, csp_directive, " +
  "webmcp_implementation, attestation, idempotency_key, input_hash, download_url, local_only, verification_mode, " +
  "verifier_protocol_version, verifier_origin_digest, verifier_webmcp_implementation, observed_artifact_url, " +
  "observed_download_url, observed_local_only, observed_integrity, observed_target_origin, registered_tools, " +
  "executed_artifact_url, served_content_hash, executed_content_hash, normal_page_load, route_interception, " +
  "injected_registration, synthetic_harness, duplicate_load_harmless, authenticated_read_tool_name, " +
  "authenticated_read_authenticated, authenticated_read_succeeded, confirmed_mutation_tool_name, " +
  "confirmed_mutation_confirmation, confirmed_mutation_reversible, confirmed_mutation_succeeded, " +
  "confirmed_mutation_effect_count, final_state_mutation_tool_name, final_state_source, final_state_verified, " +
  "created_at, verified_at";
const GITHUB_DRAFT_PULL_REQUEST_COLUMNS =
  "id, organization_id, project_id, workflow_run_id, task_id, analysis_run_id, source_snapshot_id, " +
  "project_source_id, phase, installation_id, repository_id, owner, repository, requested_ref, base_commit_sha, " +
  "patch_digest, branch, pull_request_number, pull_request_url, head_commit_sha, draft, merged, check_external_id, " +
  "check_status, check_conclusion, sandbox_reference, preview_reference, side_effect_idempotency_key, " +
  "side_effect_input_hash, output_hash, output_reference, created_at";

async function setWorkerWorkflowLeaseContext(
  db: Db,
  workerId: string,
  taskId: string,
  leaseGeneration: number,
): Promise<void> {
  await db.query(
    "select set_config('page2webmcp.workflow_task_id', $1, true), " +
    "set_config('page2webmcp.worker_id', $2, true), " +
    "set_config('page2webmcp.lease_generation', $3, true)",
    [taskId, workerId, String(leaseGeneration)],
  );
}

export class PostgresControlPlaneRepository implements ControlPlaneRepository {
  readonly #pool: pg.Pool;
  readonly #statementTimeoutMs: number;
  readonly #random: () => number;
  readonly #activeTaskQuota: number;

  constructor(options: PostgresOptions) {
    this.#pool = options.pool ?? new pg.Pool({
      connectionString: options.connectionString,
      max: Math.max(1, Math.min(options.maxConnections ?? 10, 20)),
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true
    });
    const writeLog = options.writeLog ?? ((line: string) => console.error(line));
    this.#pool.on("error", () => writeLog(JSON.stringify({
      level: "error",
      event: "database_pool_error",
      outcome: "failure",
      code: "DATABASE_CONNECTION_ERROR",
      schema_version: 1
    })));
    this.#statementTimeoutMs = Math.max(250, Math.min(options.statementTimeoutMs ?? 5_000, 30_000));
    this.#random = options.random ?? Math.random;
    this.#activeTaskQuota = Math.max(1, Math.min(options.activeTaskQuota
      ?? WORKFLOW_DEFAULT_ACTIVE_TASK_QUOTA, 100));
  }

  async #transaction<T>(context: ExecutionContext, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      await client.query(context.kind === "worker"
        ? "set local role page2webmcp_worker"
        : "set local role page2webmcp_app");
      await client.query(
        "select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), " +
        "set_config('idle_in_transaction_session_timeout', $3, true)",
        [String(this.#statementTimeoutMs), String(Math.min(this.#statementTimeoutMs, 2_000)), String(this.#statementTimeoutMs * 2)]
      );
      if (context.kind === "app") {
        await client.query(
          "select set_config('page2webmcp.organization_id', $1, true), " +
          "set_config('page2webmcp.actor_id', $2, true), set_config('page2webmcp.access', 'member', true)",
          [context.actor.organizationId, context.actor.id]
        );
      } else if (context.kind === "identity") {
        await client.query(
          "select set_config('page2webmcp.actor_id', $1, true), set_config('page2webmcp.access', 'identity', true)",
          [context.identityId]
        );
      } else if (context.kind === "artifact") {
        await client.query("select set_config('page2webmcp.access', 'artifact', true)");
      }
      const value = await action(client);
      await client.query("commit");
      return value;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Keep the original failure. The pool discards an unusable connection.
      }
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  async provisionPersonalOrganization(identity: AuthenticatedIdentity): Promise<RepositoryActor> {
    return this.#transaction({ kind: "identity", identityId: identity.id }, async (client) => {
      const result = await client.query(
        "select organization_id, user_id, role from private.provision_personal_organization($1, $2)",
        [identity.id, identity.email ?? null]
      );
      if (!result.rows[0]) throw new RepositoryError("MEMBERSHIP_REQUIRED");
      return mapActor(result.rows[0]);
    });
  }

  async resolveActor(identityId: string, organizationId?: string, sessionId?: string): Promise<RepositoryActor> {
    if (!sessionId) throw new RepositoryError("SESSION_REVOKED");
    return this.#transaction({ kind: "identity", identityId }, async (client) => {
      const result = await client.query(
        "select organization_id, user_id, role from private.resolve_identity_membership($1, $2, $3)",
        [identityId, organizationId ?? null, sessionId]
      );
      if (!result.rows[0]) throw new RepositoryError("MEMBERSHIP_REQUIRED");
      return mapActor(result.rows[0]);
    });
  }

  async #project(db: Db, actor: RepositoryActor, id: string): Promise<ProjectRecord> {
    const result = await db.query(
      "select id, organization_id, created_by, name, source_type, source_url, status, created_at " +
      "from public.projects where id = $1 and organization_id = $2 limit 1",
      [id, actor.organizationId]
    );
    if (!result.rows[0]) throw new RepositoryError("NOT_FOUND");
    return mapProject(result.rows[0]);
  }

  async #audit(db: Db, actor: RepositoryActor, action: string, targetId: string): Promise<void> {
    await db.query(
      "insert into public.audit_events (organization_id, actor_id, action, target_id) values ($1, $2, $3, $4)",
      [actor.organizationId, actor.id, action, targetId]
    );
  }

  async #reserveIdempotency(
    db: Db,
    actor: RepositoryActor,
    operation: "project" | "analysis" | "release" | "workflow",
    key: string,
    inputHash: string,
    proposedResultId: string
  ): Promise<string | undefined> {
    await db.query(
      "delete from private.idempotency_keys where organization_id = $1 and actor_id = $2 and operation = $3 " +
      "and idempotency_key = $4 and expires_at <= now()",
      [actor.organizationId, actor.id, operation, key]
    );
    const inserted = await db.query(
      "insert into private.idempotency_keys " +
      "(organization_id, actor_id, operation, idempotency_key, input_hash, result_id) " +
      "values ($1, $2, $3, $4, $5, $6) " +
      "on conflict (organization_id, actor_id, operation, idempotency_key) do nothing returning result_id",
      [actor.organizationId, actor.id, operation, key, inputHash, proposedResultId]
    );
    if (inserted.rows[0]) return undefined;
    const existing = await db.query(
      "select input_hash, result_id from private.idempotency_keys " +
      "where organization_id = $1 and actor_id = $2 and operation = $3 and idempotency_key = $4 " +
      "and expires_at > now() limit 1",
      [actor.organizationId, actor.id, operation, key]
    );
    if (!existing.rows[0] || String(existing.rows[0].input_hash) !== inputHash) {
      throw new RepositoryError("IDEMPOTENCY_CONFLICT");
    }
    return String(existing.rows[0].result_id);
  }

  async createProject(actor: RepositoryActor, input: CreateProjectRequest): Promise<ProjectRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const sourceConfiguration = normalizeSourceConfiguration(input.sourceType, input.sourceConfiguration);
      const id = randomUUID();
      const replayId = await this.#reserveIdempotency(client, actor, "project", input.idempotencyKey, input.inputHash, id);
      if (replayId) return this.#project(client, actor, replayId);
      const result = await client.query(
        "insert into public.projects " +
        "(id, organization_id, created_by, name, source_type, source_url, status) " +
        "values ($1, $2, $3, $4, $5, $6, 'created') " +
        "returning id, organization_id, created_by, name, source_type, source_url, status, created_at",
        [id, actor.organizationId, actor.id, input.name, input.sourceType, input.url]
      );
      const source = await client.query(
        "insert into public.project_sources " +
        "(organization_id, project_id, source_type, source_url, source_configuration, version, active) " +
        "values ($1, $2, $3, $4, $5::jsonb, 1, true) returning id",
        [actor.organizationId, id, input.sourceType, input.url, JSON.stringify(sourceConfiguration)]
      );
      await client.query(
        "insert into public.source_snapshots " +
        "(organization_id, project_id, project_source_id, source_identity_hash, is_fixture) values ($1, $2, $3, $4, false)",
        [actor.organizationId, id, source.rows[0].id,
          computeSourceIdentityHash(input.sourceType, input.url, sourceConfiguration)]
      );
      await this.#audit(client, actor, "project.created", id);
      return mapProject(result.rows[0]);
    });
  }

  async listProjects(actor: RepositoryActor): Promise<ProjectRecord[]> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const result = await client.query(
        "select id, organization_id, created_by, name, source_type, source_url, status, created_at " +
        "from public.projects where organization_id = $1 order by created_at, id",
        [actor.organizationId]
      );
      return result.rows.map(mapProject);
    });
  }

  async listProjectsPage(actor: RepositoryActor, input: ProjectPageRequest = {}): Promise<ProjectPage> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROJECT_PAGE_SIZE) {
      throw new RepositoryError("INVALID_CURSOR");
    }
    const cursor = input.cursor ? decodeProjectCursor(input.cursor) : undefined;
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const result = await client.query(
        "select id, organization_id, created_by, name, source_type, source_url, status, created_at " +
        "from public.projects where organization_id = $1 " +
        "and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::uuid)) " +
        "order by created_at, id limit $4",
        [actor.organizationId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]
      );
      const projects = result.rows.slice(0, limit).map(mapProject);
      return {
        projects,
        ...(result.rows.length > limit && projects.length > 0
          ? { nextCursor: encodeProjectCursor(projects[projects.length - 1]!) }
          : {})
      };
    });
  }

  async getProject(actor: RepositoryActor, id: string): Promise<ProjectRecord> {
    return this.#transaction({ kind: "app", actor }, (client) => this.#project(client, actor, id));
  }

  async getActiveProjectSource(actor: RepositoryActor, projectId: string): Promise<ProjectSourceRecord> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      const result = await client.query(
        "select id, organization_id, project_id, source_type, source_url, source_configuration, version, active, created_at " +
        "from public.project_sources where project_id = $1 and organization_id = $2 and active " +
        "limit 1",
        [projectId, actor.organizationId],
      );
      if (!result.rows[0]) throw new RepositoryError("NOT_FOUND");
      return mapProjectSource(result.rows[0]);
    });
  }

  async getLatestAnalysis(actor: RepositoryActor, projectId: string): Promise<AnalysisRunRecord | undefined> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      const result = await client.query(
        "select id, organization_id, project_id, requested_by, status, attempts, error_code, " +
        "provider_mode, provider_adapter, provider_adapter_version, provider_fixture, created_at, updated_at " +
        "from public.analysis_runs where organization_id = $1 and project_id = $2 " +
        "order by created_at desc, id desc limit 1",
        [actor.organizationId, projectId]
      );
      return result.rows[0] ? mapAnalysis(result.rows[0]) : undefined;
    });
  }

  async getAnalysisReplay(actor: RepositoryActor, input: IdempotentRequest): Promise<AnalysisRunRecord | undefined> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const project = await this.#project(client, actor, input.projectId);
      const existing = await client.query(
        "select input_hash, result_id from private.idempotency_keys " +
        "where organization_id = $1 and actor_id = $2 and operation = 'analysis' and idempotency_key = $3 " +
        "and expires_at > now() limit 1",
        [actor.organizationId, actor.id, input.idempotencyKey],
      );
      if (!existing.rows[0]) return undefined;
      if (String(existing.rows[0].input_hash) !== input.inputHash) {
        throw new RepositoryError("IDEMPOTENCY_CONFLICT");
      }
      const replay = await this.#analysis(client, actor, String(existing.rows[0].result_id));
      if (replay.projectId !== project.id) throw new RepositoryError("INVALID_STATE");
      return replay;
    });
  }

  async enqueueAnalysis(actor: RepositoryActor, input: EnqueueAnalysisRequest): Promise<AnalysisRunRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const project = await this.#project(client, actor, input.projectId);
      const runId = randomUUID();
      const replayId = await this.#reserveIdempotency(client, actor, "analysis", input.idempotencyKey, input.inputHash, runId);
      if (replayId) {
        const replay = await this.#analysis(client, actor, replayId);
        if (replay.projectId !== project.id) throw new RepositoryError("INVALID_STATE");
        return replay;
      }
      const result = await client.query(
        "with selected_source as (" +
        "select * from private.lock_active_analysis_source($2, $1, $3, $4, $5)), " +
        "inserted_run as (" +
        "insert into public.analysis_runs " +
        "(id, organization_id, project_id, requested_by, status, attempts) " +
        "select $6, $2, $1, $7, 'queued', 0 from selected_source " +
        "returning id, organization_id, project_id, requested_by, status, attempts, error_code, created_at, updated_at) " +
        "select inserted_run.*, selected_source.source_snapshot_id, selected_source.project_source_id, " +
        "selected_source.source_identity_hash, selected_source.source_type, selected_source.source_url, " +
        "selected_source.source_configuration from inserted_run cross join selected_source",
        [project.id, actor.organizationId,
          input.expectedSource?.projectSourceId ?? null,
          input.expectedSource?.sourceSnapshotId ?? null,
          input.expectedSource?.sourceIdentityHash ?? null,
          runId, actor.id]
      );
      if (!result.rows[0]) {
        throw new RepositoryError(input.expectedSource ? "SOURCE_SNAPSHOT_STALE" : "INVALID_STATE");
      }
      const sourceConfiguration = parsePersistedSourceConfiguration(
        result.rows[0].source_type as SourceType,
        result.rows[0].source_configuration as SourceConfiguration,
      );
      await client.query(
        "insert into private.analysis_jobs (analysis_run_id, organization_id, source_type, source_url, source_configuration) " +
        "values ($1, $2, $3, $4, $5::jsonb)",
        [runId, actor.organizationId, result.rows[0].source_type, result.rows[0].source_url,
          JSON.stringify(sourceConfiguration)]
      );
      const workflowInputHash = stableHash(input.inputHash);
      await client.query(
        "insert into public.workflow_runs " +
        "(id, organization_id, project_id, source_snapshot_id, analysis_run_id, status, current_phase, input_hash) " +
        "values ($1, $2, $3, $4, $1, 'queued', 'analysis', $5)",
        [runId, actor.organizationId, project.id, result.rows[0].source_snapshot_id, workflowInputHash]
      );
      const task = await client.query(
        "insert into private.workflow_tasks " +
        "(organization_id, project_id, workflow_run_id, phase, status, idempotency_key, input_hash) " +
        "values ($1, $2, $3, 'analysis', 'queued', $4, $5) returning id",
        [actor.organizationId, project.id, runId,
          workflowTaskIdempotencyKey(runId, "analysis", workflowInputHash), workflowInputHash]
      );
      await client.query("select private.append_workflow_event($1, null, 'workflow.created', null)", [runId]);
      await client.query("select private.append_workflow_event($1, $2, 'task.created', null)", [runId, task.rows[0].id]);
      await this.#audit(client, actor, "analysis.queued", runId);
      return mapAnalysis(result.rows[0]);
    });
  }

  async #analysis(db: Db, actor: RepositoryActor, id: string): Promise<AnalysisRunRecord> {
    const result = await db.query(
      "select ar.id, ar.organization_id, ar.project_id, ar.requested_by, ar.status, " +
      "ar.attempts, ar.error_code, ar.provider_mode, ar.provider_adapter, ar.provider_adapter_version, " +
      "ar.provider_fixture, ar.created_at, ar.updated_at, j.lease_owner, j.lease_expires_at " +
      "from public.analysis_runs ar left join private.analysis_jobs j " +
      "on j.analysis_run_id = ar.id and j.organization_id = ar.organization_id " +
      "where ar.id = $1 and ar.organization_id = $2 limit 1",
      [id, actor.organizationId]
    );
    if (!result.rows[0]) throw new RepositoryError("NOT_FOUND");
    return mapAnalysis(result.rows[0]);
  }

  async #lockReleaseAnalysisRun(
    db: Db,
    actor: RepositoryActor,
    projectId: string,
    runId: string
  ): Promise<void> {
    const locked = await db.query(
      "select private.lock_release_analysis_run($1, $2, $3) as locked",
      [actor.organizationId, projectId, runId]
    );
    if (!locked.rows[0]?.locked) throw new RepositoryError("INVALID_STATE");
  }

  async getAnalysis(actor: RepositoryActor, id: string): Promise<AnalysisRunRecord> {
    return this.#transaction({ kind: "app", actor }, (client) => this.#analysis(client, actor, id));
  }

  async #workflowRun(db: Db, actor: RepositoryActor, runId: string): Promise<WorkflowRunRecord> {
    const result = await db.query(
      "select id, organization_id, project_id, source_snapshot_id, analysis_run_id, reviewed_analysis_run_id, status, current_phase, " +
      "input_hash, version, cancel_requested_at, cancelled_at, error_code, created_at, updated_at " +
      "from public.workflow_runs where id = $1 and organization_id = $2 limit 1",
      [runId, actor.organizationId]
    );
    if (!result.rows[0]) throw new RepositoryError("NOT_FOUND");
    return mapWorkflowRun(result.rows[0]);
  }

  async #workerWorkflowTask(db: Db, taskId: string, lock = false): Promise<WorkflowTaskRecord> {
    const result = await db.query(
      "select task.* from private.workflow_tasks task where task.id = $1" + (lock ? " for update" : "") + " limit 1",
      [taskId]
    );
    if (!result.rows[0]) throw new RepositoryError("INVALID_STATE");
    return mapWorkflowTask(result.rows[0]);
  }

  async #workerWorkflowRun(db: Db, runId: string, lock = false): Promise<WorkflowRunRecord> {
    const result = await db.query(
      "select * from public.workflow_runs where id = $1" + (lock ? " for update" : "") + " limit 1",
      [runId]
    );
    if (!result.rows[0]) throw new RepositoryError("INVALID_STATE");
    return mapWorkflowRun(result.rows[0]);
  }

  async #assertWorkerWorkflowLease(
    db: Db,
    workerId: string,
    taskId: string,
    leaseGeneration: number,
  ): Promise<void> {
    const result = await db.query(
      "select task.status as task_status, task.lease_owner, task.lease_generation, " +
      "task.lease_expires_at > now() as lease_current, run.cancel_requested_at, run.status as run_status " +
      "from private.workflow_tasks task join public.workflow_runs run on run.id = task.workflow_run_id " +
      "where task.id = $1 limit 1",
      [taskId]
    );
    if (result.rows[0]?.cancel_requested_at || result.rows[0]?.run_status === "cancelled") {
      throw new RepositoryError("CANCELLED");
    }
    if (!result.rows[0] || result.rows[0].task_status !== "running"
      || String(result.rows[0].lease_owner) !== workerId
      || Number(result.rows[0].lease_generation) !== leaseGeneration
      || !result.rows[0].lease_current) throw new RepositoryError("LEASE_LOST");
  }

  async #workflowCommand(
    db: Db,
    runId: string,
    scope: string,
    key: string,
    inputHash: string,
  ): Promise<Record<string, unknown> | undefined> {
    assertWorkflowCommand(scope, key);
    const result = await db.query(
      "select input_hash, result from private.workflow_commands " +
      "where workflow_run_id = $1 and command_scope = $2 and idempotency_key = $3 limit 1",
      [runId, scope, key]
    );
    if (!result.rows[0]) return undefined;
    if (String(result.rows[0].input_hash) !== stableHash(inputHash)) {
      throw new RepositoryError("IDEMPOTENCY_CONFLICT");
    }
    return result.rows[0].result as Record<string, unknown>;
  }

  async #recordWorkflowCommand(
    db: Db,
    runId: string,
    taskId: string | undefined,
    scope: string,
    key: string,
    inputHash: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await db.query(
      "insert into private.workflow_commands " +
      "(workflow_run_id, task_id, command_scope, idempotency_key, input_hash, result) " +
      "values ($1, $2, $3, $4, $5, $6::jsonb)",
      [runId, taskId ?? null, scope, key, stableHash(inputHash), JSON.stringify(result)]
    );
  }

  async listProjectSources(actor: RepositoryActor, projectId: string): Promise<ProjectSourceRecord[]> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      const result = await client.query(
        "select id, organization_id, project_id, source_type, source_url, source_configuration, version, active, created_at " +
        "from public.project_sources where project_id = $1 and organization_id = $2 order by version, id limit 100",
        [projectId, actor.organizationId]
      );
      return result.rows.map(mapProjectSource);
    });
  }

  async listSourceSnapshots(actor: RepositoryActor, projectId: string): Promise<SourceSnapshotRecord[]> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      const result = await client.query(
        "select id, organization_id, project_id, project_source_id, source_identity_hash, " +
        "artifact_reference, content_hash, is_fixture, created_at from public.source_snapshots " +
        "where project_id = $1 and organization_id = $2 order by created_at, id limit 1000",
        [projectId, actor.organizationId]
      );
      return result.rows.map(mapSourceSnapshot);
    });
  }

  async startWorkflow(actor: RepositoryActor, input: StartWorkflowInput): Promise<WorkflowRunRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const project = await this.#project(client, actor, input.projectId);
      const runId = randomUUID();
      const replayId = await this.#reserveIdempotency(
        client, actor, "workflow", input.idempotencyKey, input.inputHash, runId,
      );
      if (replayId) return this.#workflowRun(client, actor, replayId);
      const snapshot = await client.query(
        "select snapshot.id from public.source_snapshots snapshot " +
        "join public.project_sources source on source.id = snapshot.project_source_id " +
        "where source.project_id = $1 and source.organization_id = $2 and source.active " +
        "order by snapshot.created_at desc, snapshot.id limit 1",
        [project.id, actor.organizationId]
      );
      if (!snapshot.rows[0]) throw new RepositoryError("INVALID_STATE");
      let reviewedAnalysisRunId: string | undefined;
      if (input.analysisRunId !== undefined) {
        if (project.sourceType !== "github") throw new RepositoryError("INVALID_STATE");
        const reviewed = await client.query(
          "select analysis.id from public.analysis_runs analysis " +
          "join public.workflow_runs compatibility on compatibility.analysis_run_id = analysis.id " +
          "where analysis.id = $1 and analysis.project_id = $2 and analysis.organization_id = $3 " +
          "and analysis.status = 'succeeded' and compatibility.source_snapshot_id = $4 " +
          "and analysis.release_code is not null and analysis.release_hash is not null " +
          "and analysis.allowed_origin is not null and analysis.release_manifest is not null limit 1",
          [input.analysisRunId, project.id, actor.organizationId, snapshot.rows[0].id]
        );
        const capabilities = await client.query(
          "select count(*)::integer as total, count(*) filter (where status = 'blocked' " +
          "or reviewed_plan_digest is distinct from plan_digest)::integer as invalid " +
          "from public.capabilities where analysis_run_id = $1 and project_id = $2 and organization_id = $3",
          [input.analysisRunId, project.id, actor.organizationId]
        );
        if (!reviewed.rows[0] || Number(capabilities.rows[0]?.total) <= 0
          || Number(capabilities.rows[0]?.invalid) > 0) throw new RepositoryError("INVALID_STATE");
        reviewedAnalysisRunId = String(reviewed.rows[0].id);
      }
      const inputHash = stableHash(input.inputHash);
      const run = await client.query(
        "insert into public.workflow_runs " +
        "(id, organization_id, project_id, source_snapshot_id, reviewed_analysis_run_id, status, current_phase, input_hash) " +
        "values ($1, $2, $3, $4, $5, 'queued', 'preflight', $6) returning *",
        [runId, actor.organizationId, project.id, snapshot.rows[0].id, reviewedAnalysisRunId ?? null, inputHash]
      );
      const task = await client.query(
        "insert into private.workflow_tasks " +
        "(organization_id, project_id, workflow_run_id, phase, status, idempotency_key, input_hash) " +
        "values ($1, $2, $3, 'preflight', 'queued', $4, $5) returning id",
        [actor.organizationId, project.id, runId, workflowTaskIdempotencyKey(runId, "preflight", inputHash), inputHash]
      );
      await client.query("select private.append_workflow_event($1, null, 'workflow.created', null)", [runId]);
      await client.query("select private.append_workflow_event($1, $2, 'task.created', null)", [runId, task.rows[0].id]);
      await client.query("update public.projects set status = 'analyzing' where id = $1", [project.id]);
      await this.#audit(client, actor, "workflow.queued", runId);
      return this.#workflowRun(client, actor, String(run.rows[0].id));
    });
  }

  async getWorkflowRun(actor: RepositoryActor, runId: string): Promise<WorkflowRunRecord> {
    return this.#transaction({ kind: "app", actor }, (client) => this.#workflowRun(client, actor, runId));
  }

  async getLatestReviewedWorkflowForAnalysis(
    actor: RepositoryActor,
    projectId: string,
    analysisRunId: string,
  ): Promise<WorkflowRunRecord | undefined> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const project = await this.#project(client, actor, projectId);
      if (project.sourceType !== "github") return undefined;
      const result = await client.query(
        "select id, organization_id, project_id, source_snapshot_id, analysis_run_id, reviewed_analysis_run_id, " +
        "status, current_phase, input_hash, version, cancel_requested_at, cancelled_at, error_code, created_at, updated_at " +
        "from public.workflow_runs where project_id = $1 and organization_id = $2 and reviewed_analysis_run_id = $3 " +
        "order by created_at desc, id desc limit 1",
        [project.id, actor.organizationId, analysisRunId],
      );
      return result.rows[0] ? mapWorkflowRun(result.rows[0]) : undefined;
    });
  }

  async listWorkflowTasks(actor: RepositoryActor, runId: string): Promise<WorkflowTaskRecord[]> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#workflowRun(client, actor, runId);
      const result = await client.query(
        "select task.* from private.workflow_tasks task where workflow_run_id = $1 " +
        "and organization_id = $2 order by created_at, id limit 100",
        [runId, actor.organizationId]
      );
      return result.rows.map(mapWorkflowTask);
    });
  }

  async listWorkflowEvents(actor: RepositoryActor, runId: string): Promise<WorkflowEventRecord[]> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#workflowRun(client, actor, runId);
      const result = await client.query(
        "select id, organization_id, project_id, workflow_run_id, task_id, sequence, version, " +
        "event_type, code, payload, created_at from public.workflow_events where workflow_run_id = $1 " +
        "and organization_id = $2 order by sequence limit 1000",
        [runId, actor.organizationId]
      );
      return result.rows.map(mapWorkflowEvent);
    });
  }

  async listWorkflowEvidence(actor: RepositoryActor, runId: string): Promise<WorkflowEvidenceLink[]> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#workflowRun(client, actor, runId);
      const result = await client.query(
        "select id, organization_id, project_id, workflow_run_id, task_id, evidence_id, reference, created_at " +
        "from public.workflow_evidence where workflow_run_id = $1 and organization_id = $2 order by reference limit 1000",
        [runId, actor.organizationId]
      );
      return result.rows.map(mapWorkflowEvidence);
    });
  }

  async listWorkflowCapabilityPlans(actor: RepositoryActor, runId: string): Promise<WorkflowCapabilityPlanLink[]> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#workflowRun(client, actor, runId);
      const result = await client.query(
        "select id, organization_id, project_id, workflow_run_id, task_id, capability_id, plan_digest, created_at " +
        "from public.capability_plans where workflow_run_id = $1 and organization_id = $2 order by plan_digest limit 1000",
        [runId, actor.organizationId]
      );
      return result.rows.map(mapWorkflowCapabilityPlan);
    });
  }

  async claimWorkflowTask(workerId: string): Promise<ClaimedWorkflowTaskRecord | undefined> {
    assertWorkflowWorkerId(workerId);
    return this.#transaction({ kind: "worker" }, async (client) => {
      const candidate = await client.query(
        "select task.id, task.organization_id, task.workflow_run_id from private.workflow_tasks task " +
        "join public.workflow_runs run on run.id = task.workflow_run_id " +
        "where task.phase <> 'analysis' and task.attempts < task.max_attempts " +
        "and run.cancel_requested_at is null and run.status not in ('succeeded','failed','cancelled') " +
        "and ((task.status = 'queued' and task.available_at <= now()) " +
        "or (task.status = 'running' and task.lease_expires_at <= now())) " +
        "and (select count(*) from private.workflow_tasks active where active.organization_id = task.organization_id " +
        "and active.status = 'running' and active.lease_expires_at > now()) < $1 " +
        "order by coalesce((select max(event.created_at) from public.workflow_events event " +
        "where event.organization_id = task.organization_id and event.event_type = 'task.claimed'), '-infinity'), " +
        "task.available_at, task.created_at, task.id limit 1",
        [this.#activeTaskQuota]
      );
      if (!candidate.rows[0]) return undefined;
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [String(candidate.rows[0].organization_id)]);
      const runLock = await client.query(
        "select id, source_snapshot_id from public.workflow_runs where id = $1 and cancel_requested_at is null " +
        "and status not in ('succeeded','failed','cancelled') for update",
        [candidate.rows[0].workflow_run_id]
      );
      if (!runLock.rows[0]) return undefined;
      const taskLock = await client.query(
        "select id from private.workflow_tasks where id = $1 and attempts < max_attempts " +
        "and ((status = 'queued' and available_at <= now()) " +
        "or (status = 'running' and lease_expires_at <= now())) for update skip locked",
        [candidate.rows[0].id]
      );
      if (!taskLock.rows[0]) return undefined;
      const active = await client.query(
        "select count(*)::integer as count from private.workflow_tasks where organization_id = $1 " +
        "and status = 'running' and lease_expires_at > now()",
        [candidate.rows[0].organization_id]
      );
      if (Number(active.rows[0]?.count) >= this.#activeTaskQuota) return undefined;
      const claimed = await client.query(
        "update private.workflow_tasks set status = 'running', attempts = attempts + 1, " +
        "lease_generation = lease_generation + 1, lease_owner = $2, " +
        "lease_expires_at = now() + ($3::integer * interval '1 millisecond'), error_code = null, updated_at = now() " +
        "where id = $1 returning *",
        [candidate.rows[0].id, workerId, WORKFLOW_LEASE_MS]
      );
      const task = mapWorkflowTask(claimed.rows[0]) as ClaimedWorkflowTaskRecord;
      await client.query(
        "update public.workflow_runs set status = 'running', current_phase = $2, error_code = null, updated_at = now() " +
        "where id = $1 and cancel_requested_at is null",
        [task.workflowRunId, task.phase]
      );
      await client.query("select private.append_workflow_event($1, $2, 'task.claimed', null)", [task.workflowRunId, task.id]);
      return task;
    });
  }

  async assertWorkflowTaskLease(workerId: string, taskId: string, leaseGeneration: number): Promise<void> {
    await this.#transaction({ kind: "worker" }, async (client) => {
      await this.#assertWorkerWorkflowLease(client, workerId, taskId, leaseGeneration);
    });
  }

  async recordWorkflowTaskEvent(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: WorkflowTaskEventInput,
  ): Promise<WorkflowEventRecord> {
    const payload = workflowTaskEventPayload(input);
    return this.#transaction({ kind: "worker" }, async (client) => {
      await this.#assertWorkerWorkflowLease(client, workerId, taskId, leaseGeneration);
      await client.query(
        "select set_config('page2webmcp.workflow_task_id', $1, true), " +
        "set_config('page2webmcp.worker_id', $2, true), " +
        "set_config('page2webmcp.lease_generation', $3, true)",
        [taskId, workerId, String(leaseGeneration)],
      );
      const event = await client.query(
        "select (private.append_workflow_task_event($1, $2, $3::jsonb)).*",
        [taskId, input.type, JSON.stringify(payload)],
      );
      if (!event.rows[0]) throw new RepositoryError("INVALID_STATE");
      return mapWorkflowEvent(event.rows[0]);
    });
  }

  async getWorkflowExecutionMaterial(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
  ): Promise<WorkflowExecutionMaterial> {
    return this.#transaction({ kind: "worker" }, async (client) => {
      await this.#assertWorkerWorkflowLease(client, workerId, taskId, leaseGeneration);
      await client.query(
        "select set_config('page2webmcp.workflow_task_id', $1, true), " +
        "set_config('page2webmcp.worker_id', $2, true), " +
        "set_config('page2webmcp.lease_generation', $3, true)",
        [taskId, workerId, String(leaseGeneration)],
      );
      const context = await client.query(
        "select run.id as workflow_run_id, run.project_id, run.source_snapshot_id, " +
        "run.reviewed_analysis_run_id, source.source_type, source.source_url " +
        "from private.workflow_tasks task join public.workflow_runs run on run.id = task.workflow_run_id " +
        "join public.source_snapshots snapshot on snapshot.id = run.source_snapshot_id " +
        "join public.project_sources source on source.id = snapshot.project_source_id " +
        "where task.id = $1 and source.project_id = run.project_id and source.organization_id = run.organization_id limit 1",
        [taskId]
      );
      const row = context.rows[0];
      if (!row || row.source_type !== "github" || !row.reviewed_analysis_run_id) {
        throw new RepositoryError("INVALID_STATE");
      }
      const analysisRunId = String(row.reviewed_analysis_run_id);
      const run = await client.query(
        "select result, release_code, release_hash, allowed_origin, release_manifest " +
        "from public.analysis_runs where id = $1 and project_id = $2 and status = 'succeeded' limit 1",
        [analysisRunId, row.project_id]
      );
      const capabilities = await client.query(
        "select id, organization_id, project_id, analysis_run_id, stable_name, risk_tier, status, plan, " +
        "plan_digest, reviewed_plan_digest, version from public.capabilities " +
        "where analysis_run_id = $1 and project_id = $2 order by stable_name, id limit $3",
        [analysisRunId, row.project_id, MAX_CAPABILITIES]
      );
      const evidence = await client.query(
        "select id, organization_id, project_id, analysis_run_id, source, content, reference, expires_at " +
        "from public.analysis_evidence where analysis_run_id = $1 and project_id = $2 " +
        "and expires_at > now() order by created_at, id limit $3",
        [analysisRunId, row.project_id, MAX_EVIDENCE]
      );
      const storedCapabilities = capabilities.rows.map(mapCapability);
      const analysisRow = run.rows[0];
      if (!analysisRow || storedCapabilities.length === 0 || evidence.rows.length === 0
        || storedCapabilities.some((capability) => capability.status === "blocked"
          || capability.reviewedPlanDigest !== capability.planDigest)) {
        throw new RepositoryError("INVALID_STATE");
      }
      const stored = analysisRow.result as { diagnostics?: AnalysisResult["diagnostics"] } | null;
      const analysis: AnalysisResult = {
        capabilities: storedCapabilities.map(({ plan, status }) => ({ plan, status })),
        diagnostics: normalizeAnalysisDiagnostics(stored?.diagnostics ?? []),
        evidence: evidence.rows.map(mapEvidence),
        release: {
          code: String(analysisRow.release_code),
          contentHash: String(analysisRow.release_hash),
          allowedOrigin: String(analysisRow.allowed_origin),
          manifest: analysisRow.release_manifest,
        },
      };
      return {
        workflowRunId: String(row.workflow_run_id),
        projectId: String(row.project_id),
        sourceSnapshotId: String(row.source_snapshot_id),
        sourceType: "github",
        sourceUrl: String(row.source_url),
        analysisRunId,
        analysis,
        capabilities: storedCapabilities,
      };
    });
  }

  async getGitHubDraftPullRequestForTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
  ): Promise<GitHubDraftPullRequestRecord | undefined> {
    return this.#transaction({ kind: "worker" }, async (client) => {
      await this.#assertWorkerWorkflowLease(client, workerId, taskId, leaseGeneration);
      await setWorkerWorkflowLeaseContext(client, workerId, taskId, leaseGeneration);
      const result = await client.query(
        `select ${GITHUB_DRAFT_PULL_REQUEST_COLUMNS} from public.github_draft_pull_requests ` +
        "where task_id = $1 limit 1",
        [taskId],
      );
      return result.rows[0] ? mapGitHubDraftPullRequest(result.rows[0]) : undefined;
    });
  }

  async saveGitHubDraftPullRequest(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: SaveGitHubDraftPullRequestRequest,
  ): Promise<GitHubDraftPullRequestRecord> {
    const material = await this.getWorkflowExecutionMaterial(workerId, taskId, leaseGeneration);
    return this.#transaction({ kind: "worker" }, async (client) => {
      await this.#assertWorkerWorkflowLease(client, workerId, taskId, leaseGeneration);
      await setWorkerWorkflowLeaseContext(client, workerId, taskId, leaseGeneration);
      const context = await client.query(
        "select task.organization_id, task.project_id, task.workflow_run_id, task.phase, " +
        "run.reviewed_analysis_run_id, run.source_snapshot_id, snapshot.project_source_id " +
        "from private.workflow_tasks task join public.workflow_runs run on run.id = task.workflow_run_id " +
        "join public.source_snapshots snapshot on snapshot.id = run.source_snapshot_id " +
        "where task.id = $1 limit 1",
        [taskId],
      );
      const row = context.rows[0];
      if (!row || !["publish", "install_verify"].includes(String(row.phase))
        || String(row.workflow_run_id) !== input.workflowRunId
        || String(row.reviewed_analysis_run_id) !== input.analysisRunId) throw new RepositoryError("INVALID_STATE");
      const id = randomUUID();
      const url = `https://github.com/${input.owner}/${input.repository}/pull/${input.number}`;
      const inserted = await client.query(
        "insert into public.github_draft_pull_requests " +
        "(id, organization_id, project_id, workflow_run_id, task_id, analysis_run_id, source_snapshot_id, " +
        "project_source_id, phase, installation_id, repository_id, owner, repository, requested_ref, base_commit_sha, " +
        "patch_digest, branch, pull_request_number, pull_request_url, head_commit_sha, draft, merged, check_external_id, " +
        "check_status, check_conclusion, sandbox_reference, preview_reference, side_effect_idempotency_key, " +
        "side_effect_input_hash, output_hash, output_reference) " +
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25," +
        "$26,$27,$28,$29,$30,$31) on conflict (task_id) do nothing " +
        `returning ${GITHUB_DRAFT_PULL_REQUEST_COLUMNS}`,
        [id, row.organization_id, row.project_id, row.workflow_run_id, taskId, row.reviewed_analysis_run_id,
          row.source_snapshot_id, row.project_source_id, row.phase, input.installationId, input.repositoryId,
          input.owner, input.repository, input.requestedRef, input.baseCommitSha, input.patchDigest, input.branch,
          input.number, url, input.headCommitSha, input.draft, input.merged, input.check.externalId,
          input.check.status, input.check.conclusion ?? null, input.sandboxReference, input.previewReference ?? null,
          input.sideEffectIdempotencyKey, input.sideEffectInputHash, input.outputHash, input.outputReference],
      );
      let record = inserted.rows[0] ? mapGitHubDraftPullRequest(inserted.rows[0]) : undefined;
      if (!record) {
        const existing = await client.query(
          `select ${GITHUB_DRAFT_PULL_REQUEST_COLUMNS} from public.github_draft_pull_requests ` +
          "where task_id = $1 limit 1",
          [taskId],
        );
        record = existing.rows[0] ? mapGitHubDraftPullRequest(existing.rows[0]) : undefined;
      }
      if (!record || !gitHubDraftPullRequestMatchesRequest(record, input)) {
        throw new RepositoryError("IDEMPOTENCY_CONFLICT");
      }
      return normalizeGitHubDraftPullRequest(record, material);
    });
  }

  async getLatestGitHubDraftPullRequest(
    actor: RepositoryActor,
    workflowRunId: string,
  ): Promise<GitHubDraftPullRequestRecord | undefined> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const run = await client.query(
        "select id, project_id from public.workflow_runs where id = $1 and organization_id = $2 limit 1",
        [workflowRunId, actor.organizationId],
      );
      if (!run.rows[0]) throw new RepositoryError("NOT_FOUND");
      const result = await client.query(
        `select ${GITHUB_DRAFT_PULL_REQUEST_COLUMNS} from public.github_draft_pull_requests ` +
        "where workflow_run_id = $1 and organization_id = $2 " +
        "order by (phase = 'install_verify') desc, created_at desc, id desc limit 1",
        [workflowRunId, actor.organizationId],
      );
      return result.rows[0] ? mapGitHubDraftPullRequest(result.rows[0]) : undefined;
    });
  }

  async getLatestGitHubDraftPullRequestForProject(
    actor: RepositoryActor,
    projectId: string,
  ): Promise<GitHubDraftPullRequestRecord | undefined> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const project = await client.query(
        "select id, source_type from public.projects where id = $1 and organization_id = $2 limit 1",
        [projectId, actor.organizationId],
      );
      if (!project.rows[0]) throw new RepositoryError("NOT_FOUND");
      if (String(project.rows[0].source_type) !== "github") return undefined;
      const result = await client.query(
        `select ${GITHUB_DRAFT_PULL_REQUEST_COLUMNS} from public.github_draft_pull_requests ` +
        "where project_id = $1 and organization_id = $2 " +
        "order by created_at desc, (phase = 'install_verify') desc, id desc limit 1",
        [projectId, actor.organizationId],
      );
      return result.rows[0] ? mapGitHubDraftPullRequest(result.rows[0]) : undefined;
    });
  }

  async heartbeatWorkflowTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
  ): Promise<WorkflowTaskRecord> {
    return this.#transaction({ kind: "worker" }, async (client) => {
      const cancelled = await client.query(
        "select run.cancel_requested_at from private.workflow_tasks task join public.workflow_runs run " +
        "on run.id = task.workflow_run_id where task.id = $1 for update of run",
        [taskId]
      );
      if (cancelled.rows[0]?.cancel_requested_at) throw new RepositoryError("CANCELLED");
      const result = await client.query(
        "update private.workflow_tasks set lease_expires_at = now() + ($4::integer * interval '1 millisecond'), " +
        "updated_at = now() where id = $1 and status = 'running' and lease_owner = $2 " +
        "and lease_generation = $3 and lease_expires_at > now() returning *",
        [taskId, workerId, leaseGeneration, WORKFLOW_LEASE_MS]
      );
      if (!result.rows[0]) throw new RepositoryError("LEASE_LOST");
      const task = mapWorkflowTask(result.rows[0]);
      await client.query("select private.append_workflow_event($1, $2, 'task.heartbeat', null)", [task.workflowRunId, task.id]);
      return task;
    });
  }

  async completeWorkflowTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: CompleteWorkflowTaskInput,
  ): Promise<WorkflowTaskCompletion> {
    validateWorkflowReference(input.checkpointReference);
    validateWorkflowReference(input.outputReference);
    return this.#transaction({ kind: "worker" }, async (client) => {
      let task = await this.#workerWorkflowTask(client, taskId);
      const run = await this.#workerWorkflowRun(client, task.workflowRunId, true);
      task = await this.#workerWorkflowTask(client, taskId, true);
      const scope = `complete:${taskId}`;
      const replay = await this.#workflowCommand(client, task.workflowRunId, scope, input.idempotencyKey, input.inputHash);
      if (replay) {
        const replayTask = await this.#workerWorkflowTask(client, String(replay.taskId));
        const replayRun = await this.#workerWorkflowRun(client, replayTask.workflowRunId);
        const nextTask = replay.nextTaskId
          ? await this.#workerWorkflowTask(client, String(replay.nextTaskId))
          : undefined;
        return { run: replayRun, task: replayTask, ...(nextTask ? { nextTask } : {}) };
      }
      if (run.cancelRequestedAt || run.status === "cancelled") throw new RepositoryError("CANCELLED");
      await this.#assertWorkerWorkflowLease(client, workerId, task.id, leaseGeneration);
      const outputHash = stableHash(canonicalJson({
        checkpointReference: input.checkpointReference,
        commandInputHash: stableHash(input.inputHash),
        outputReference: input.outputReference,
      }));
      const completed = await client.query(
        "update private.workflow_tasks set status = 'succeeded', output_hash = $2, " +
        "checkpoint_reference = $3, output_reference = $4, lease_owner = null, lease_expires_at = null, " +
        "retry_classification = null, error_code = null, updated_at = now() where id = $1 returning *",
        [task.id, outputHash, input.checkpointReference ?? null, input.outputReference ?? null]
      );
      const completedTask = mapWorkflowTask(completed.rows[0]);
      await client.query("select private.append_workflow_event($1, $2, 'task.completed', null)", [run.id, task.id]);
      const nextPhase = task.phase === "analysis" ? undefined : workflowPhase(task.phase).next;
      let nextTask: WorkflowTaskRecord | undefined;
      if (nextPhase) {
        await client.query(
          "update public.workflow_runs set status = 'queued', current_phase = $2, error_code = null, updated_at = now() " +
          "where id = $1",
          [run.id, nextPhase]
        );
        const next = await client.query(
          "insert into private.workflow_tasks " +
          "(organization_id, project_id, workflow_run_id, phase, status, idempotency_key, input_hash) " +
          "values ($1, $2, $3, $4, 'queued', $5, $6) on conflict (workflow_run_id, phase) do nothing returning *",
          [run.organizationId, run.projectId, run.id, nextPhase,
            workflowTaskIdempotencyKey(run.id, nextPhase, outputHash), outputHash]
        );
        if (!next.rows[0]) {
          const existing = await client.query(
            "select * from private.workflow_tasks where workflow_run_id = $1 and phase = $2 limit 1",
            [run.id, nextPhase]
          );
          if (!existing.rows[0]) throw new RepositoryError("INVALID_STATE");
          nextTask = mapWorkflowTask(existing.rows[0]);
        } else {
          nextTask = mapWorkflowTask(next.rows[0]);
          await client.query("select private.append_workflow_event($1, $2, 'task.created', null)", [run.id, nextTask.id]);
        }
      } else {
        await client.query(
          "update public.workflow_runs set status = 'succeeded', error_code = null, updated_at = now() where id = $1",
          [run.id]
        );
        await client.query("select private.append_workflow_event($1, null, 'workflow.completed', null)", [run.id]);
        await client.query("update public.projects set status = 'analyzed' where id = $1", [run.projectId]);
      }
      await this.#recordWorkflowCommand(client, run.id, task.id, scope, input.idempotencyKey, input.inputHash, {
        taskId: completedTask.id,
        ...(nextTask ? { nextTaskId: nextTask.id } : {}),
      });
      return {
        run: await this.#workerWorkflowRun(client, run.id),
        task: completedTask,
        ...(nextTask ? { nextTask } : {}),
      };
    });
  }

  async failWorkflowTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: FailWorkflowTaskInput,
  ): Promise<WorkflowTaskRecord> {
    validateWorkflowErrorCode(input.errorCode);
    return this.#transaction({ kind: "worker" }, async (client) => {
      let task = await this.#workerWorkflowTask(client, taskId);
      const run = await this.#workerWorkflowRun(client, task.workflowRunId, true);
      task = await this.#workerWorkflowTask(client, taskId, true);
      const scope = `fail:${taskId}`;
      const replay = await this.#workflowCommand(client, task.workflowRunId, scope, input.idempotencyKey, input.inputHash);
      if (replay) return this.#workerWorkflowTask(client, String(replay.taskId));
      if (run.cancelRequestedAt || run.status === "cancelled") throw new RepositoryError("CANCELLED");
      await this.#assertWorkerWorkflowLease(client, workerId, task.id, leaseGeneration);
      const terminal = input.classification === "permanent" || task.attempts >= task.maxAttempts;
      const retryDelayMs = terminal ? 0 : workflowRetryDelayMs(
        task.attempts,
        input.classification === "rate_limited" ? input.retryAfterMs : undefined,
        this.#random,
      );
      const result = await client.query(
        "update private.workflow_tasks set status = $2, retry_classification = $3, error_code = $4, " +
        "available_at = case when $2 = 'queued' then now() + ($5::integer * interval '1 millisecond') else available_at end, " +
        "lease_owner = null, lease_expires_at = null, updated_at = now() where id = $1 returning *",
        [task.id, terminal ? "failed" : "queued", input.classification, input.errorCode, retryDelayMs]
      );
      const failed = mapWorkflowTask(result.rows[0]);
      await client.query(
        "update public.workflow_runs set status = $2, error_code = $3, updated_at = now() where id = $1",
        [run.id, terminal ? "failed" : "queued", input.errorCode]
      );
      await client.query(
        "select private.append_workflow_event($1, $2, $3, $4)",
        [run.id, task.id, terminal ? "task.failed" : "task.retry_scheduled", input.errorCode]
      );
      if (terminal) {
        await client.query("select private.append_workflow_event($1, null, 'workflow.failed', $2)", [run.id, input.errorCode]);
        await client.query("update public.projects set status = 'failed' where id = $1", [run.projectId]);
      }
      await this.#recordWorkflowCommand(client, run.id, task.id, scope, input.idempotencyKey, input.inputHash, {
        taskId: failed.id,
      });
      return failed;
    });
  }

  async waitWorkflowTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: WaitWorkflowTaskInput,
  ): Promise<Readonly<{ task: WorkflowTaskRecord; waitToken: string }>> {
    validateWorkflowWait(input.reason, input.expiresAt);
    return this.#transaction({ kind: "worker" }, async (client) => {
      let task = await this.#workerWorkflowTask(client, taskId);
      const run = await this.#workerWorkflowRun(client, task.workflowRunId, true);
      task = await this.#workerWorkflowTask(client, taskId, true);
      if (run.cancelRequestedAt || run.status === "cancelled") throw new RepositoryError("CANCELLED");
      await this.#assertWorkerWorkflowLease(client, workerId, task.id, leaseGeneration);
      const waitToken = randomUUID().replaceAll("-", "");
      const waiting = await client.query(
        "update private.workflow_tasks set status = 'waiting', wait_key_hash = $2, wait_reason = $3, " +
        "wait_expires_at = $4::timestamptz, lease_owner = null, lease_expires_at = null, updated_at = now() " +
        "where id = $1 returning *",
        [task.id, stableHash(waitToken), input.reason, input.expiresAt]
      );
      await client.query("update public.workflow_runs set status = 'waiting', updated_at = now() where id = $1", [run.id]);
      await client.query("select private.append_workflow_event($1, $2, 'task.waiting', null)", [run.id, task.id]);
      return { task: mapWorkflowTask(waiting.rows[0]), waitToken };
    });
  }

  async resumeWorkflowTask(actor: RepositoryActor, input: ResumeWorkflowTaskInput): Promise<WorkflowTaskRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.waitToken)) throw new RepositoryError("INVALID_STATE");
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const scope = `resume:${input.runId}`;
      const runResult = await client.query(
        "select * from public.workflow_runs where id = $1 and organization_id = $2 for update",
        [input.runId, actor.organizationId]
      );
      if (!runResult.rows[0]) throw new RepositoryError("NOT_FOUND");
      const run = mapWorkflowRun(runResult.rows[0]);
      const replay = await this.#workflowCommand(client, input.runId, scope, input.idempotencyKey, input.inputHash);
      if (replay) {
        const task = await client.query(
          "select * from private.workflow_tasks where id = $1 and organization_id = $2 limit 1",
          [String(replay.taskId), actor.organizationId]
        );
        if (!task.rows[0]) throw new RepositoryError("NOT_FOUND");
        return mapWorkflowTask(task.rows[0]);
      }
      if (run.cancelRequestedAt || run.status === "cancelled") throw new RepositoryError("CANCELLED");
      const taskResult = await client.query(
        "select * from private.workflow_tasks where workflow_run_id = $1 and organization_id = $2 " +
        "and wait_key_hash = $3 for update limit 1",
        [run.id, actor.organizationId, stableHash(input.waitToken)]
      );
      if (!taskResult.rows[0]) throw new RepositoryError("INVALID_STATE");
      const task = mapWorkflowTask(taskResult.rows[0]);
      if (task.status !== "waiting") throw new RepositoryError("INVALID_STATE");
      if (!task.waitExpiresAt || new Date(task.waitExpiresAt) <= new Date()) throw new RepositoryError("WAIT_EXPIRED");
      const resumed = await client.query(
        "update private.workflow_tasks set status = 'queued', resumed_at = now(), available_at = now(), updated_at = now() " +
        "where id = $1 returning *",
        [task.id]
      );
      await client.query("update public.workflow_runs set status = 'queued', updated_at = now() where id = $1", [run.id]);
      await client.query("select private.append_workflow_event($1, $2, 'task.resumed', null)", [run.id, task.id]);
      await this.#recordWorkflowCommand(client, run.id, task.id, scope, input.idempotencyKey, input.inputHash, {
        taskId: task.id,
      });
      return mapWorkflowTask(resumed.rows[0]);
    });
  }

  async cancelWorkflow(actor: RepositoryActor, input: CancelWorkflowInput): Promise<WorkflowRunRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const locked = await client.query(
        "select * from public.workflow_runs where id = $1 and organization_id = $2 for update",
        [input.runId, actor.organizationId]
      );
      if (!locked.rows[0]) throw new RepositoryError("NOT_FOUND");
      const run = mapWorkflowRun(locked.rows[0]);
      const scope = `cancel:${run.id}`;
      const replay = await this.#workflowCommand(client, run.id, scope, input.idempotencyKey, input.inputHash);
      if (replay) return this.#workerWorkflowRun(client, String(replay.runId));
      if (["succeeded", "failed", "cancelled"].includes(run.status)) throw new RepositoryError("INVALID_STATE");
      if (run.analysisRunId) {
        await client.query(
          "select analysis_run_id from private.analysis_jobs where analysis_run_id = $1 for update",
          [run.analysisRunId],
        );
      }
      await client.query(
        "update public.workflow_runs set cancel_requested_at = now(), updated_at = now() where id = $1",
        [run.id]
      );
      await client.query("select private.append_workflow_event($1, null, 'workflow.cancel_requested', null)", [run.id]);
      const cancelledTasks = await client.query(
        "update private.workflow_tasks set status = 'cancelled', cancel_requested_at = now(), cancelled_at = now(), " +
        "lease_owner = null, lease_expires_at = null, updated_at = now() where workflow_run_id = $1 " +
        "and status in ('queued','running','waiting') returning id",
        [run.id]
      );
      for (const task of cancelledTasks.rows) {
        await client.query("select private.append_workflow_event($1, $2, 'task.cancelled', null)", [run.id, task.id]);
      }
      if (run.analysisRunId) {
        await client.query(
          "update private.website_authentication_checkpoints set state = 'cancelled', terminal_at = now(), updated_at = now() " +
          "where analysis_run_id = $1 and state in ('waiting','consumed')",
          [run.analysisRunId],
        );
      }
      await client.query(
        "update public.workflow_runs set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = $1",
        [run.id]
      );
      await client.query("select private.append_workflow_event($1, null, 'workflow.cancelled', null)", [run.id]);
      if (run.analysisRunId) {
        await client.query(
          "update private.analysis_jobs set status = 'cancelled', lease_owner = null, lease_expires_at = null, " +
          "updated_at = now() where analysis_run_id = $1 and status in ('queued','running','waiting')",
          [run.analysisRunId]
        );
      }
      await this.#recordWorkflowCommand(client, run.id, undefined, scope, input.idempotencyKey, input.inputHash, {
        runId: run.id,
      });
      return this.#workerWorkflowRun(client, run.id);
    });
  }

  async reconcileWorkflows(workerId: string): Promise<number> {
    assertWorkflowWorkerId(workerId);
    return this.#transaction({ kind: "worker" }, async (client) => {
      let repaired = 0;
      const expiredAuthentication = await client.query(
        "select authentication.analysis_run_id, authentication.workflow_task_id " +
        "from private.website_authentication_checkpoints authentication " +
        "join private.analysis_jobs job on job.analysis_run_id = authentication.analysis_run_id " +
        "join private.workflow_tasks task on task.id = authentication.workflow_task_id " +
        "join public.workflow_runs run on run.id = authentication.analysis_run_id " +
        "where authentication.state in ('waiting','consumed') and authentication.expires_at <= now() " +
        "and job.status in ('waiting','queued') and task.status in ('waiting','queued') " +
        "and run.status in ('waiting','queued') order by authentication.expires_at, authentication.analysis_run_id limit 100",
      );
      for (const row of expiredAuthentication.rows) {
        const runId = String(row.analysis_run_id);
        const runLock = await client.query(
          "select id from public.workflow_runs where id = $1 and status in ('waiting','queued') " +
          "and cancel_requested_at is null for update",
          [runId],
        );
        if (!runLock.rows[0]) continue;
        const jobLock = await client.query(
          "select analysis_run_id from private.analysis_jobs where analysis_run_id = $1 " +
          "and status in ('waiting','queued') for update skip locked",
          [runId],
        );
        if (!jobLock.rows[0]) continue;
        const taskLock = await client.query(
          "select id from private.workflow_tasks where id = $1 and workflow_run_id = $2 " +
          "and status in ('waiting','queued') for update skip locked",
          [row.workflow_task_id, runId],
        );
        if (!taskLock.rows[0]) continue;
        const checkpointLock = await client.query(
          "select analysis_run_id from private.website_authentication_checkpoints where analysis_run_id = $1 " +
          "and state in ('waiting','consumed') and expires_at <= now() for update skip locked",
          [runId],
        );
        if (!checkpointLock.rows[0]) continue;
        await client.query(
          "update private.website_authentication_checkpoints set state = 'expired', terminal_at = now(), updated_at = now() " +
          "where analysis_run_id = $1 and state in ('waiting','consumed')",
          [runId],
        );
        await client.query(
          "update private.workflow_tasks set status = 'failed', retry_classification = 'permanent', " +
          "error_code = 'AUTHENTICATION_WAIT_EXPIRED', lease_owner = null, lease_expires_at = null, " +
          "reconciled_at = now(), updated_at = now() where id = $1",
          [row.workflow_task_id],
        );
        await client.query(
          "update private.analysis_jobs set status = 'failed', lease_owner = null, lease_expires_at = null, " +
          "updated_at = now() where analysis_run_id = $1",
          [runId],
        );
        await client.query(
          "update public.analysis_runs set error_code = 'AUTHENTICATION_WAIT_EXPIRED', updated_at = now() where id = $1",
          [runId],
        );
        await client.query(
          "update public.workflow_runs set status = 'failed', error_code = 'AUTHENTICATION_WAIT_EXPIRED', " +
          "updated_at = now() where id = $1",
          [runId],
        );
        await client.query(
          "select private.append_workflow_event($1, $2, 'task.reconciled', 'AUTHENTICATION_WAIT_EXPIRED')",
          [runId, row.workflow_task_id],
        );
        await client.query("select private.append_workflow_event($1, null, 'workflow.reconciled', null)", [runId]);
        repaired += 1;
      }
      const expired = await client.query(
        "select task.* from private.workflow_tasks task join public.workflow_runs run on run.id = task.workflow_run_id " +
        "where task.phase <> 'analysis' and task.status = 'running' and task.lease_expires_at <= now() " +
        "and run.cancel_requested_at is null and run.status not in ('succeeded','failed','cancelled') " +
        "order by task.lease_expires_at, task.id limit 100"
      );
      for (const row of expired.rows) {
        const task = mapWorkflowTask(row);
        const runLock = await client.query(
          "select id from public.workflow_runs where id = $1 and cancel_requested_at is null " +
          "and status not in ('succeeded','failed','cancelled') for update",
          [task.workflowRunId]
        );
        if (!runLock.rows[0]) continue;
        const taskLock = await client.query(
          "select id from private.workflow_tasks where id = $1 and status = 'running' " +
          "and lease_expires_at <= now() for update skip locked",
          [task.id]
        );
        if (!taskLock.rows[0]) continue;
        const terminal = task.attempts >= task.maxAttempts;
        await client.query(
          "update private.workflow_tasks set status = $2, lease_owner = null, lease_expires_at = null, " +
          "available_at = now(), reconciled_at = now(), error_code = case when $2 = 'failed' " +
          "then 'ATTEMPTS_EXHAUSTED' else error_code end, updated_at = now() where id = $1",
          [task.id, terminal ? "failed" : "queued"]
        );
        await client.query(
          "update public.workflow_runs set status = $2, error_code = case when $2 = 'failed' " +
          "then 'ATTEMPTS_EXHAUSTED' else error_code end, updated_at = now() where id = $1",
          [task.workflowRunId, terminal ? "failed" : "queued"]
        );
        await client.query(
          "select private.append_workflow_event($1, $2, 'task.reconciled', $3)",
          [task.workflowRunId, task.id, terminal ? "ATTEMPTS_EXHAUSTED" : null]
        );
        await client.query("select private.append_workflow_event($1, null, 'workflow.reconciled', null)", [task.workflowRunId]);
        repaired += 1;
      }
      const missing = await client.query(
        "select task.* from private.workflow_tasks task join public.workflow_runs run on run.id = task.workflow_run_id " +
        "where task.phase <> 'analysis' and task.status = 'succeeded' " +
        "and run.status in ('queued','running','waiting') order by task.updated_at, task.id limit 100"
      );
      for (const row of missing.rows) {
        const task = mapWorkflowTask(row);
        if (task.phase === "analysis") continue;
        const nextPhase = workflowPhase(task.phase).next;
        if (!nextPhase) continue;
        const run = await this.#workerWorkflowRun(client, task.workflowRunId, true);
        if (run.cancelRequestedAt || ["succeeded", "failed", "cancelled"].includes(run.status)) continue;
        const exists = await client.query(
          "select id from private.workflow_tasks where workflow_run_id = $1 and phase = $2 limit 1",
          [task.workflowRunId, nextPhase]
        );
        if (exists.rows[0]) continue;
        const inputHash = task.outputHash ?? task.inputHash;
        await client.query(
          "update public.workflow_runs set status = 'queued', current_phase = $2, updated_at = now() where id = $1",
          [run.id, nextPhase]
        );
        const created = await client.query(
          "insert into private.workflow_tasks " +
          "(organization_id, project_id, workflow_run_id, phase, status, idempotency_key, input_hash) " +
          "values ($1, $2, $3, $4, 'queued', $5, $6) returning id",
          [run.organizationId, run.projectId, run.id, nextPhase,
            workflowTaskIdempotencyKey(run.id, nextPhase, inputHash), inputHash]
        );
        await client.query(
          "update private.workflow_tasks set reconciled_at = now(), updated_at = now() where id = $1",
          [created.rows[0].id]
        );
        await client.query("select private.append_workflow_event($1, $2, 'task.created', null)", [run.id, created.rows[0].id]);
        await client.query("select private.append_workflow_event($1, null, 'workflow.reconciled', null)", [run.id]);
        repaired += 1;
      }
      return repaired;
    });
  }

  async #workerAnalysis(db: Db, id: string): Promise<AnalysisRunRecord> {
    const result = await db.query(
      "select ar.id, ar.organization_id, ar.project_id, ar.requested_by, ar.status, ar.attempts, " +
      "ar.error_code, ar.provider_mode, ar.provider_adapter, ar.provider_adapter_version, ar.provider_fixture, " +
      "ar.created_at, ar.updated_at, j.lease_owner, j.lease_expires_at " +
      "from public.analysis_runs ar join private.analysis_jobs j " +
      "on j.analysis_run_id = ar.id and j.organization_id = ar.organization_id " +
      "where ar.id = $1 limit 1",
      [id]
    );
    if (!result.rows[0]) throw new RepositoryError("INVALID_STATE");
    return mapAnalysis(result.rows[0]);
  }

  async claimAnalysis(
    workerId: string,
    leaseMs: number,
    sourceTypes?: readonly SourceType[],
  ): Promise<ClaimedAnalysisRunRecord | undefined> {
    const allowedSourceTypes = normalizeAnalysisSourceTypes(sourceTypes);
    const sourceTypeFilter = allowedSourceTypes ? [...allowedSourceTypes] : null;
    return this.#transaction({ kind: "worker" }, async (client) => {
      const exhausted = await client.query(
        "select analysis_run_id from private.analysis_jobs where status = 'running' " +
        "and lease_expires_at <= now() and attempts >= 3 " +
        "and ($1::text[] is null or source_type = any($1::text[])) " +
        "order by lease_expires_at, analysis_run_id limit 100",
        [sourceTypeFilter]
      );
      for (const exhaustedJob of exhausted.rows) {
        const exhaustedRunId = String(exhaustedJob.analysis_run_id);
        const runLock = await client.query(
          "select id from public.workflow_runs where id = $1 and cancel_requested_at is null " +
          "and status = 'running' for update",
          [exhaustedRunId]
        );
        if (!runLock.rows[0]) continue;
        const jobLock = await client.query(
          "select analysis_run_id from private.analysis_jobs where analysis_run_id = $1 and status = 'running' " +
          "and lease_expires_at <= now() and attempts >= 3 for update skip locked",
          [exhaustedRunId]
        );
        if (!jobLock.rows[0]) continue;
        await client.query(
          "update public.analysis_runs set error_code = 'ATTEMPTS_EXHAUSTED', updated_at = now() where id = $1",
          [exhaustedRunId]
        );
        await client.query(
          "update private.analysis_jobs set status = 'failed', lease_owner = null, lease_expires_at = null, " +
          "updated_at = now() where analysis_run_id = $1",
          [exhaustedRunId]
        );
        const workflowTask = await client.query(
          "update private.workflow_tasks set status = 'failed', error_code = 'ATTEMPTS_EXHAUSTED', " +
          "lease_owner = null, lease_expires_at = null, updated_at = now() " +
          "where workflow_run_id = $1 and phase = 'analysis' and status = 'running' returning id",
          [exhaustedRunId]
        );
        await client.query(
          "update private.website_authentication_checkpoints set state = 'failed', terminal_at = now(), updated_at = now() " +
          "where analysis_run_id = $1 and state = 'consumed'",
          [exhaustedRunId],
        );
        if (workflowTask.rows[0]) {
          await client.query(
            "update public.workflow_runs set status = 'failed', error_code = 'ATTEMPTS_EXHAUSTED', updated_at = now() where id = $1",
            [exhaustedRunId]
          );
          await client.query(
            "select private.append_workflow_event($1, $2, 'task.failed', 'ATTEMPTS_EXHAUSTED')",
            [exhaustedRunId, workflowTask.rows[0].id]
          );
          await client.query(
            "select private.append_workflow_event($1, null, 'workflow.failed', 'ATTEMPTS_EXHAUSTED')",
            [exhaustedRunId]
          );
        }
      }
      const candidate = await client.query(
        "select job.analysis_run_id, job.organization_id from private.analysis_jobs job " +
        "where ((job.status = 'queued' and job.available_at <= now()) or " +
        "(job.status = 'running' and job.lease_expires_at <= now())) and job.attempts < 3 " +
        "and ($2::text[] is null or job.source_type = any($2::text[])) " +
        "and not exists (select 1 from private.website_authentication_checkpoints authentication " +
        "where authentication.analysis_run_id = job.analysis_run_id and (authentication.state <> 'consumed' " +
        "or authentication.authentication_evidence_reference is null or authentication.expires_at <= now())) " +
        "and (select count(*) from private.workflow_tasks active where active.organization_id = job.organization_id " +
        "and active.status = 'running' and active.lease_expires_at > now()) < $1 " +
        "order by coalesce((select max(event.created_at) from public.workflow_events event " +
        "where event.organization_id = job.organization_id and event.event_type = 'task.claimed'), '-infinity'), " +
        "job.available_at, job.created_at, job.analysis_run_id limit 1",
        [this.#activeTaskQuota, sourceTypeFilter]
      );
      const runId = candidate.rows[0]?.analysis_run_id;
      if (!runId) return undefined;
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [String(candidate.rows[0].organization_id)]);
      const runLock = await client.query(
        "select id from public.workflow_runs where id = $1 and cancel_requested_at is null " +
        "and status not in ('succeeded','failed','cancelled') for update",
        [runId]
      );
      if (!runLock.rows[0]) return undefined;
      const jobLock = await client.query(
        "select * from private.analysis_jobs where analysis_run_id = $1 and attempts < 3 " +
        "and ((status = 'queued' and available_at <= now()) " +
        "or (status = 'running' and lease_expires_at <= now())) for update skip locked",
        [runId]
      );
      if (!jobLock.rows[0]) return undefined;
      const workflowTaskLock = await client.query(
        "select * from private.workflow_tasks where workflow_run_id = $1 and phase = 'analysis' " +
        "and status in ('queued','running') for update",
        [runId],
      );
      if (!workflowTaskLock.rows[0]) return undefined;
      const active = await client.query(
        "select count(*)::integer as count from private.workflow_tasks where organization_id = $1 " +
        "and status = 'running' and lease_expires_at > now()",
        [candidate.rows[0].organization_id]
      );
      if (Number(active.rows[0]?.count) >= this.#activeTaskQuota) return undefined;
      const boundedLease = Math.max(1_000, Math.min(leaseMs, 300_000));
      const job = await client.query(
        "update private.analysis_jobs set status = 'running', attempts = attempts + 1, lease_owner = $2, " +
        "lease_expires_at = now() + ($3::integer * interval '1 millisecond'), updated_at = now() " +
        "where analysis_run_id = $1 returning attempts, lease_owner, lease_expires_at, source_type, source_url, source_configuration",
        [runId, workerId, boundedLease]
      );
      const workflowTaskResult = await client.query(
        "update private.workflow_tasks set status = 'running', attempts = $2, " +
        "lease_generation = lease_generation + 1, lease_owner = $3, lease_expires_at = $4, " +
        "error_code = null, updated_at = now() where id = $1 " +
        "and status in ('queued','running') returning *",
        [workflowTaskLock.rows[0].id, Number(job.rows[0].attempts), workerId, job.rows[0].lease_expires_at]
      );
      if (!workflowTaskResult.rows[0]) throw new RepositoryError("INVALID_STATE");
      const workflowTask = mapWorkflowTask(workflowTaskResult.rows[0]);
      await client.query(
        "update public.workflow_runs set status = 'running', current_phase = 'analysis', error_code = null, updated_at = now() " +
        "where id = $1 and cancel_requested_at is null",
        [runId]
      );
      await setWorkerWorkflowLeaseContext(
        client,
        workerId,
        workflowTask.id,
        workflowTask.leaseGeneration,
      );
      const authenticationResult = await client.query(
        "select authentication.*, workflow.source_snapshot_id as workflow_source_snapshot_id, " +
        "snapshot.source_identity_hash as persisted_source_identity_hash " +
        "from private.website_authentication_checkpoints authentication " +
        "join public.workflow_runs workflow on workflow.id = authentication.analysis_run_id " +
        "join public.source_snapshots snapshot on snapshot.id = authentication.source_snapshot_id " +
        "and snapshot.project_id = authentication.project_id and snapshot.organization_id = authentication.organization_id " +
        "where authentication.analysis_run_id = $1 for update of authentication",
        [runId],
      );
      const authenticationCheckpoint = authenticationResult.rows[0]
        ? mapWebsiteAuthenticationCheckpoint(authenticationResult.rows[0])
        : undefined;
      if (authenticationCheckpoint && (authenticationCheckpoint.state !== "consumed"
        || !authenticationCheckpoint.authenticationEvidenceReference
        || new Date(authenticationCheckpoint.expiresAt) <= new Date()
        || authenticationCheckpoint.workflowTaskId !== workflowTask.id
        || authenticationCheckpoint.sourceSnapshotId !== String(authenticationResult.rows[0].workflow_source_snapshot_id)
        || authenticationCheckpoint.sourceIdentityHash !== String(authenticationResult.rows[0].persisted_source_identity_hash)
        || authenticationCheckpoint.targetOriginDigest !== websiteTargetOriginDigest(String(job.rows[0].source_url)))) {
        throw new RepositoryError("INVALID_STATE");
      }
      await client.query("select private.append_workflow_event($1, $2, 'task.claimed', null)", [runId, workflowTask.id]);
      const result = await client.query(
        "select ar.id, ar.organization_id, ar.project_id, ar.requested_by, ar.status, ar.attempts, " +
        "ar.error_code, ar.created_at, ar.updated_at, $2::text as lease_owner, $3::timestamptz as lease_expires_at, " +
        "$4::text as source_type, $5::text as source_url, $6::jsonb as source_configuration, $7::uuid as workflow_task_id, " +
        "$8::bigint as lease_generation, $9::uuid as source_snapshot_id " +
        "from public.analysis_runs ar where ar.id = $1 limit 1",
        [runId, job.rows[0].lease_owner, job.rows[0].lease_expires_at, job.rows[0].source_type,
          job.rows[0].source_url, JSON.stringify(parsePersistedSourceConfiguration(
            job.rows[0].source_type as SourceType,
            job.rows[0].source_configuration as SourceConfiguration,
          )), workflowTask.id, workflowTask.leaseGeneration, runLock.rows[0].source_snapshot_id]
      );
      if (!result.rows[0]) throw new RepositoryError("INVALID_STATE");
      if (authenticationCheckpoint) {
        Object.assign(result.rows[0], {
          authentication_checkpoint_reference: authenticationCheckpoint.checkpointReference,
          authentication_evidence_reference: authenticationCheckpoint.authenticationEvidenceReference,
          authentication_source_snapshot_id: authenticationCheckpoint.sourceSnapshotId,
          authentication_source_identity_hash: authenticationCheckpoint.sourceIdentityHash,
          authentication_target_origin_digest: authenticationCheckpoint.targetOriginDigest,
          authentication_expires_at: authenticationCheckpoint.expiresAt,
        });
      }
      return mapClaimedAnalysis(result.rows[0]);
    });
  }

  async heartbeatAnalysis(workerId: string, runId: string, leaseMs: number, leaseGeneration?: number): Promise<void> {
    const boundedLease = Math.max(1_000, Math.min(leaseMs, 300_000));
    await this.#transaction({ kind: "worker" }, async (client) => {
      const workflow = await this.#workerWorkflowRun(client, runId, true);
      if (workflow.cancelRequestedAt || workflow.status === "cancelled") throw new RepositoryError("CANCELLED");
      const result = await client.query(
        "update private.analysis_jobs set lease_expires_at = now() + ($3::integer * interval '1 millisecond'), " +
        "updated_at = now() where analysis_run_id = $1 and status = 'running' and lease_owner = $2 " +
        "and lease_expires_at > now() returning analysis_run_id",
        [runId, workerId, boundedLease]
      );
      if (!result.rows[0]) throw new RepositoryError("LEASE_LOST");
      const task = await client.query(
        "update private.workflow_tasks set lease_expires_at = now() + ($4::integer * interval '1 millisecond'), " +
        "updated_at = now() where workflow_run_id = $1 and phase = 'analysis' and status = 'running' " +
        "and lease_owner = $2 and lease_generation = coalesce($3, lease_generation) " +
        "and lease_expires_at > now() returning id",
        [runId, workerId, leaseGeneration ?? null, boundedLease]
      );
      if (!task.rows[0]) throw new RepositoryError("LEASE_LOST");
      await client.query("select private.append_workflow_event($1, $2, 'task.heartbeat', null)", [runId, task.rows[0].id]);
    });
  }

  async waitAnalysisForAuthentication(
    workerId: string,
    runId: string,
    input: WaitAnalysisForAuthenticationInput,
    leaseGeneration?: number,
  ): Promise<WebsiteAuthenticationCheckpointRecord> {
    assertWorkflowWorkerId(workerId);
    const normalized = normalizeWebsiteAuthenticationWaitInput(input, new Date());
    const waitInputHash = stableHashBounded(input.inputHash);
    return this.#transaction({ kind: "worker" }, async (client) => {
      const workflowResult = await client.query(
        "select * from public.workflow_runs where id = $1 for update",
        [runId],
      );
      if (!workflowResult.rows[0]) throw new RepositoryError("INVALID_STATE");
      const workflow = mapWorkflowRun(workflowResult.rows[0]);

      const jobResult = await client.query(
        "select job.*, analysis.project_id, analysis.organization_id as analysis_organization_id " +
        "from private.analysis_jobs job join public.analysis_runs analysis " +
        "on analysis.id = job.analysis_run_id and analysis.organization_id = job.organization_id " +
        "where job.analysis_run_id = $1 for update of job",
        [runId],
      );
      const taskResult = await client.query(
        "select * from private.workflow_tasks where workflow_run_id = $1 and phase = 'analysis' for update",
        [runId],
      );
      if (!jobResult.rows[0] || !taskResult.rows[0]) throw new RepositoryError("INVALID_STATE");
      const task = mapWorkflowTask(taskResult.rows[0]);
      const existingResult = await client.query(
        "select * from private.website_authentication_checkpoints where analysis_run_id = $1 for update",
        [runId],
      );
      if (existingResult.rows[0]) {
        const existing = mapWebsiteAuthenticationCheckpoint(existingResult.rows[0]);
        if (String(existingResult.rows[0].wait_idempotency_key) !== input.idempotencyKey
          || String(existingResult.rows[0].wait_input_hash) !== waitInputHash
          || !websiteAuthenticationWaitMatches(existing, normalized)) {
          throw new RepositoryError("IDEMPOTENCY_CONFLICT");
        }
        return existing;
      }

      if (workflow.cancelRequestedAt || workflow.status === "cancelled") throw new RepositoryError("CANCELLED");
      const job = jobResult.rows[0];
      if (job.source_type !== "website") throw new RepositoryError("INVALID_STATE");
      if (job.status !== "running" || String(job.lease_owner) !== workerId
        || !job.lease_expires_at || new Date(job.lease_expires_at) <= new Date()
        || task.status !== "running" || task.leaseOwner !== workerId
        || !task.leaseExpiresAt || new Date(task.leaseExpiresAt) <= new Date()
        || task.leaseGeneration !== (leaseGeneration ?? task.leaseGeneration)) {
        throw new RepositoryError("LEASE_LOST");
      }
      if (workflow.status !== "running" || workflow.sourceSnapshotId !== normalized.sourceSnapshotId
        || workflow.organizationId !== String(job.organization_id)
        || workflow.projectId !== String(job.project_id)) {
        throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
      }
      await setWorkerWorkflowLeaseContext(client, workerId, task.id, task.leaseGeneration);
      const snapshotResult = await client.query(
        "select id, organization_id, project_id, source_identity_hash from public.source_snapshots " +
        "where id = $1 and organization_id = $2 and project_id = $3 limit 1",
        [workflow.sourceSnapshotId, workflow.organizationId, workflow.projectId],
      );
      const snapshot = snapshotResult.rows[0];
      if (!snapshot || normalized.sourceIdentityHash !== String(snapshot.source_identity_hash)) {
        throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
      }
      if (normalized.targetOriginDigest !== websiteTargetOriginDigest(String(job.source_url))) {
        throw new RepositoryError("INVALID_STATE");
      }

      const inserted = await client.query(
        "insert into private.website_authentication_checkpoints " +
        "(analysis_run_id, organization_id, project_id, workflow_task_id, source_snapshot_id, " +
        "source_identity_hash, target_origin_digest, checkpoint_reference, state, expires_at, " +
        "wait_idempotency_key, wait_input_hash) " +
        "values ($1, $2, $3, $4, $5, $6, $7, $8, 'waiting', $9::timestamptz, $10, $11) returning *",
        [runId, workflow.organizationId, workflow.projectId, task.id, workflow.sourceSnapshotId,
          normalized.sourceIdentityHash, normalized.targetOriginDigest, normalized.checkpointReference,
          normalized.expiresAt, input.idempotencyKey, waitInputHash],
      );
      const updatedTask = await client.query(
        "update private.workflow_tasks set status = 'waiting', checkpoint_reference = $2, " +
        "wait_key_hash = $3, wait_reason = 'external_authentication', wait_expires_at = $4::timestamptz, " +
        "lease_owner = null, lease_expires_at = null, error_code = null, updated_at = now() " +
        "where id = $1 and status = 'running' returning id",
        [task.id, normalized.checkpointReference,
          stableHash(`${input.idempotencyKey}\0${waitInputHash}`), normalized.expiresAt],
      );
      if (!updatedTask.rows[0]) throw new RepositoryError("LEASE_LOST");
      const updatedJob = await client.query(
        "update private.analysis_jobs set status = 'waiting', lease_owner = null, lease_expires_at = null, " +
        "updated_at = now() where analysis_run_id = $1 and status = 'running' returning analysis_run_id",
        [runId],
      );
      if (!updatedJob.rows[0]) throw new RepositoryError("LEASE_LOST");
      const updatedWorkflow = await client.query(
        "update public.workflow_runs set status = 'waiting', error_code = null, updated_at = now() " +
        "where id = $1 and status = 'running' and cancel_requested_at is null returning id",
        [runId],
      );
      if (!updatedWorkflow.rows[0]) throw new RepositoryError("INVALID_STATE");
      await client.query("select private.append_workflow_event($1, $2, 'task.waiting', null)", [runId, task.id]);
      return mapWebsiteAuthenticationCheckpoint(inserted.rows[0]);
    });
  }

  async getWebsiteAuthenticationWait(
    actor: RepositoryActor,
    runId: string,
  ): Promise<WebsiteAuthenticationCheckpointRecord | undefined> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const run = await client.query(
        "select id from public.workflow_runs where id = $1 and organization_id = $2 limit 1",
        [runId, actor.organizationId],
      );
      if (!run.rows[0]) throw new RepositoryError("NOT_FOUND");
      const result = await client.query(
        "select * from private.website_authentication_checkpoints " +
        "where analysis_run_id = $1 and organization_id = $2 limit 1",
        [runId, actor.organizationId],
      );
      return result.rows[0] ? mapWebsiteAuthenticationCheckpoint(result.rows[0]) : undefined;
    });
  }

  async resumeAnalysisAfterAuthentication(
    actor: RepositoryActor,
    input: ResumeAnalysisAfterAuthenticationInput,
  ): Promise<WebsiteAuthenticationCheckpointRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    const normalized = normalizeWebsiteAuthenticationResumeInput(input);
    const resumeInputHash = stableHashBounded(input.inputHash);
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const workflowResult = await client.query(
        "select * from public.workflow_runs where id = $1 and organization_id = $2 for update",
        [input.runId, actor.organizationId],
      );
      if (!workflowResult.rows[0]) throw new RepositoryError("NOT_FOUND");
      const workflow = mapWorkflowRun(workflowResult.rows[0]);
      const jobResult = await client.query(
        "select * from private.analysis_jobs where analysis_run_id = $1 and organization_id = $2 for update",
        [input.runId, actor.organizationId],
      );
      const taskResult = await client.query(
        "select * from private.workflow_tasks where workflow_run_id = $1 and phase = 'analysis' " +
        "and organization_id = $2 for update",
        [input.runId, actor.organizationId],
      );
      const checkpointResult = await client.query(
        "select * from private.website_authentication_checkpoints " +
        "where analysis_run_id = $1 and organization_id = $2 for update",
        [input.runId, actor.organizationId],
      );
      if (!jobResult.rows[0] || !taskResult.rows[0] || !checkpointResult.rows[0]) {
        throw new RepositoryError("INVALID_STATE");
      }
      const task = mapWorkflowTask(taskResult.rows[0]);
      const checkpoint = mapWebsiteAuthenticationCheckpoint(checkpointResult.rows[0]);
      if (checkpointResult.rows[0].resume_idempotency_key !== null) {
        if (String(checkpointResult.rows[0].resume_idempotency_key) !== input.idempotencyKey
          || String(checkpointResult.rows[0].resume_input_hash) !== resumeInputHash
          || !websiteAuthenticationResumeMatches(checkpoint, normalized)) {
          throw new RepositoryError("IDEMPOTENCY_CONFLICT");
        }
        return checkpoint;
      }
      if (workflow.cancelRequestedAt || workflow.status === "cancelled") throw new RepositoryError("CANCELLED");
      if (checkpoint.state !== "waiting" || workflow.status !== "waiting") {
        throw new RepositoryError("INVALID_STATE");
      }
      if (new Date(checkpoint.expiresAt) <= new Date()) throw new RepositoryError("WAIT_EXPIRED");
      if (checkpoint.sourceSnapshotId !== normalized.sourceSnapshotId
        || checkpoint.sourceIdentityHash !== normalized.sourceIdentityHash) {
        throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
      }
      if (!websiteAuthenticationResumeMatches(checkpoint, normalized)) {
        throw new RepositoryError("INVALID_STATE");
      }
      const snapshot = await client.query(
        "select id, source_identity_hash from public.source_snapshots " +
        "where id = $1 and project_id = $2 and organization_id = $3 limit 1",
        [checkpoint.sourceSnapshotId, checkpoint.projectId, checkpoint.organizationId],
      );
      if (!snapshot.rows[0] || String(snapshot.rows[0].source_identity_hash) !== checkpoint.sourceIdentityHash
        || workflow.sourceSnapshotId !== checkpoint.sourceSnapshotId) {
        throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
      }
      if (jobResult.rows[0].status !== "waiting" || task.status !== "waiting"
        || task.checkpointReference !== checkpoint.checkpointReference
        || task.waitReason !== "external_authentication") {
        throw new RepositoryError("INVALID_STATE");
      }

      const consumed = await client.query(
        "update private.website_authentication_checkpoints set state = 'consumed', " +
        "authentication_evidence_reference = $2, resume_idempotency_key = $3, resume_input_hash = $4, " +
        "consumed_at = now(), updated_at = now() where analysis_run_id = $1 and state = 'waiting' returning *",
        [input.runId, normalized.authenticationEvidenceReference, input.idempotencyKey, resumeInputHash],
      );
      if (!consumed.rows[0]) throw new RepositoryError("INVALID_STATE");
      const updatedTask = await client.query(
        "update private.workflow_tasks set status = 'queued', resumed_at = now(), available_at = now(), " +
        "lease_owner = null, lease_expires_at = null, updated_at = now() " +
        "where id = $1 and status = 'waiting' returning id",
        [task.id],
      );
      const updatedJob = await client.query(
        "update private.analysis_jobs set status = 'queued', available_at = now(), lease_owner = null, " +
        "lease_expires_at = null, updated_at = now() " +
        "where analysis_run_id = $1 and status = 'waiting' returning analysis_run_id",
        [input.runId],
      );
      const updatedWorkflow = await client.query(
        "update public.workflow_runs set status = 'queued', error_code = null, updated_at = now() " +
        "where id = $1 and status = 'waiting' and cancel_requested_at is null returning id",
        [input.runId],
      );
      if (!updatedTask.rows[0] || !updatedJob.rows[0] || !updatedWorkflow.rows[0]) {
        throw new RepositoryError("INVALID_STATE");
      }
      await client.query("select private.append_workflow_event($1, $2, 'task.resumed', null)", [input.runId, task.id]);
      return mapWebsiteAuthenticationCheckpoint(consumed.rows[0]);
    });
  }

  async completeAnalysis(
    workerId: string,
    runId: string,
    result: AnalysisResult,
    leaseGeneration?: number,
  ): Promise<AnalysisRunRecord> {
    if (result.capabilities.length > MAX_CAPABILITIES || result.evidence.length > MAX_EVIDENCE
      || result.release !== undefined && Buffer.byteLength(result.release.code) > MAX_RELEASE_BYTES) {
      throw new RepositoryError("INVALID_STATE");
    }
    let canonicalPlans: readonly CapabilityPlan[];
    try {
      canonicalPlans = result.capabilities.length === 0
        ? []
        : canonicalizeCapabilityPlans(result.capabilities.map(({ plan }) => plan));
    } catch {
      throw new RepositoryError("INVALID_STATE");
    }
    const normalizedDiagnostics = normalizeAnalysisDiagnostics(result.diagnostics);
    if (canonicalPlans.length === 0) {
      if (normalizedDiagnostics.length === 0 || result.evidence.length === 0 || result.release !== undefined) {
        throw new RepositoryError("INVALID_STATE");
      }
    } else {
      if (result.release === undefined) throw new RepositoryError("INVALID_STATE");
      const sourcePlans = plansFromManifest(result.release.manifest);
      if (!sourcePlans || !equalPlanSets(sourcePlans, canonicalPlans)) throw new RepositoryError("INVALID_STATE");
    }
    const statuses = new Map(result.capabilities.map(({ plan, status }) => [plan.tool.name, status]));
    return this.#transaction({ kind: "worker" }, async (client) => {
      const workflow = await this.#workerWorkflowRun(client, runId, true);
      if (workflow.cancelRequestedAt || workflow.status === "cancelled") throw new RepositoryError("CANCELLED");
      const job = await client.query(
        "select j.organization_id, ar.project_id, j.source_type, task.id as workflow_task_id, " +
        "task.lease_generation as workflow_lease_generation from private.analysis_jobs j " +
        "join public.analysis_runs ar on ar.id = j.analysis_run_id and ar.organization_id = j.organization_id " +
        "join private.workflow_tasks task on task.workflow_run_id = j.analysis_run_id and task.phase = 'analysis' " +
        "where j.analysis_run_id = $1 and j.status = 'running' and j.lease_owner = $2 " +
        "and j.lease_expires_at > now() and task.status = 'running' and task.lease_owner = $2 " +
        "and task.lease_expires_at > now() and task.lease_generation = coalesce($3, task.lease_generation) " +
        "for update of j, task",
        [runId, workerId, leaseGeneration ?? null]
      );
      if (!job.rows[0]) throw new RepositoryError("LEASE_LOST");
      const organizationId = String(job.rows[0].organization_id);
      const projectId = String(job.rows[0].project_id);
      const workflowTaskId = String(job.rows[0].workflow_task_id);
      const providerProvenance = result.providerProvenance === undefined ? undefined
        : normalizeProviderProvenance(result.providerProvenance, job.rows[0].source_type as SourceType);
      const normalizedEvidence = result.evidence.map((item) => normalizeEvidence(
        item,
        organizationId,
        projectId,
        runId,
      ));
      if (new Set(normalizedEvidence.map(({ reference }) => reference)).size !== normalizedEvidence.length
        || normalizedEvidence.reduce((total, item) => total + Buffer.byteLength(item.content), 0) > MAX_RELEASE_BYTES) {
        throw new RepositoryError("INVALID_STATE");
      }
      if (!evidenceResolves(normalizedEvidence, canonicalPlans,
        organizationId, projectId, runId, new Date())) {
        throw new RepositoryError("INVALID_STATE");
      }
      const insertedEvidence: Array<{ id: string; reference: string }> = [];
      for (const evidence of normalizedEvidence) {
        await client.query(
          "insert into public.analysis_evidence " +
          "(id, organization_id, project_id, analysis_run_id, source, payload, content, reference, expires_at) " +
          "values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz)",
          [evidence.id, organizationId, projectId, runId, evidence.source, JSON.stringify(evidence),
            evidence.content, evidence.reference, evidence.expiresAt]
        );
        insertedEvidence.push({ id: evidence.id, reference: evidence.reference });
      }
      const insertedCapabilities: Array<{ id: string; planDigest: string }> = [];
      for (const plan of canonicalPlans) {
        const status = statuses.get(plan.tool.name) ?? "proposed";
        const planDigest = capabilityPlanDigest(plan);
        const capabilityId = randomUUID();
        await client.query(
          "insert into public.capabilities " +
          "(id, organization_id, project_id, analysis_run_id, stable_name, risk_tier, status, plan, plan_digest, " +
          "reviewed_plan_digest, version) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 1)",
          [capabilityId, organizationId, projectId, runId, plan.tool.name, plan.effects.riskTier, status,
            JSON.stringify(plan), planDigest, plan.effects.riskTier === "R0" || status === "blocked" ? planDigest : null]
        );
        insertedCapabilities.push({ id: capabilityId, planDigest });
      }
      const releaseHash = result.release === undefined
        ? null
        : createHash("sha256").update(Buffer.from(result.release.code)).digest("hex");
      await client.query(
        "update public.analysis_runs set result = $2::jsonb, release_code = $3, release_hash = $4, " +
        "allowed_origin = $5, release_manifest = $6::jsonb, provider_mode = $7, provider_adapter = $8, " +
        "provider_adapter_version = $9, provider_fixture = $10, error_code = null, updated_at = now() where id = $1",
        [runId, JSON.stringify({ diagnostics: normalizedDiagnostics, draftPullRequest: result.draftPullRequest }),
          result.release?.code ?? null, releaseHash, result.release?.allowedOrigin ?? null,
          result.release === undefined ? null : JSON.stringify(result.release.manifest ?? {}),
          providerProvenance?.mode ?? null, providerProvenance?.adapter ?? null,
          providerProvenance?.adapterVersion ?? null, providerProvenance?.fixture ?? null]
      );
      const completed = await client.query(
        "update private.analysis_jobs set status = 'succeeded', lease_owner = null, lease_expires_at = null, " +
        "updated_at = now() where analysis_run_id = $1 and lease_owner = $2 and lease_expires_at > now() " +
        "returning analysis_run_id",
        [runId, workerId]
      );
      if (!completed.rows[0]) throw new RepositoryError("LEASE_LOST");
      await client.query(
        "update private.website_authentication_checkpoints set state = 'completed', terminal_at = now(), updated_at = now() " +
        "where analysis_run_id = $1 and state = 'consumed'",
        [runId],
      );
      const outputHash = stableHash(canonicalJson({
        diagnostics: normalizedDiagnostics,
        evidence: insertedEvidence.map(({ reference }) => reference).sort(compareStrings),
        plans: insertedCapabilities.map(({ planDigest }) => planDigest).sort(compareStrings),
        release: releaseHash ?? undefined,
        providerProvenance,
      }));
      await client.query(
        "update private.workflow_tasks set status = 'succeeded', output_hash = $2, output_reference = $3, " +
        "lease_owner = null, lease_expires_at = null, error_code = null, updated_at = now() " +
        "where id = $1 and lease_generation = coalesce($4, lease_generation)",
        [workflowTaskId, outputHash,
          releaseHash ? `urn:sha256:${releaseHash}` : insertedEvidence[0]?.reference ?? null,
          leaseGeneration ?? null]
      );
      for (const evidence of insertedEvidence) {
        await client.query(
          "insert into public.workflow_evidence " +
          "(organization_id, project_id, workflow_run_id, task_id, evidence_id, reference) " +
          "values ($1, $2, $3, $4, $5, $6)",
          [organizationId, projectId, runId, workflowTaskId, evidence.id, evidence.reference]
        );
      }
      for (const capability of insertedCapabilities) {
        await client.query(
          "insert into public.capability_plans " +
          "(organization_id, project_id, workflow_run_id, task_id, capability_id, plan_digest) " +
          "values ($1, $2, $3, $4, $5, $6)",
          [organizationId, projectId, runId, workflowTaskId, capability.id, capability.planDigest]
        );
      }
      await client.query(
        "update public.workflow_runs set status = 'succeeded', error_code = null, updated_at = now() where id = $1",
        [runId]
      );
      await client.query("select private.append_workflow_event($1, $2, 'task.completed', null)", [runId, workflowTaskId]);
      await client.query("select private.append_workflow_event($1, null, 'workflow.completed', null)", [runId]);
      return this.#workerAnalysis(client, runId);
    });
  }

  async failAnalysis(
    workerId: string,
    runId: string,
    code: string,
    retryable: boolean,
    leaseGeneration?: number,
  ): Promise<AnalysisRunRecord> {
    return this.#transaction({ kind: "worker" }, async (client) => {
      const workflow = await this.#workerWorkflowRun(client, runId, true);
      if (workflow.cancelRequestedAt || workflow.status === "cancelled") throw new RepositoryError("CANCELLED");
      const job = await client.query(
        "select job.attempts, task.id as workflow_task_id from private.analysis_jobs job " +
        "join private.workflow_tasks task on task.workflow_run_id = job.analysis_run_id and task.phase = 'analysis' " +
        "where job.analysis_run_id = $1 and job.status = 'running' and job.lease_owner = $2 " +
        "and job.lease_expires_at > now() and task.status = 'running' and task.lease_owner = $2 " +
        "and task.lease_expires_at > now() and task.lease_generation = coalesce($3, task.lease_generation) " +
        "for update of job, task",
        [runId, workerId, leaseGeneration ?? null]
      );
      if (!job.rows[0]) throw new RepositoryError("LEASE_LOST");
      const terminal = !retryable || Number(job.rows[0].attempts) >= 3;
      const workflowCode = normalizeWorkflowErrorCode(code);
      const retryDelayMs = terminal ? 0 : workflowRetryDelayMs(Number(job.rows[0].attempts), undefined, this.#random);
      await client.query("update public.analysis_runs set error_code = $2, updated_at = now() where id = $1", [runId, code.slice(0, 128)]);
      await client.query(
        "update private.analysis_jobs set status = $2, " +
        "available_at = case when $2 = 'queued' then now() + ($3::integer * interval '1 millisecond') else available_at end, " +
        "lease_owner = null, lease_expires_at = null, updated_at = now() where analysis_run_id = $1",
        [runId, terminal ? "failed" : "queued", retryDelayMs]
      );
      await client.query(
        "update private.workflow_tasks set status = $2, retry_classification = $3, error_code = $4, " +
        "available_at = case when $2 = 'queued' then now() + ($5::integer * interval '1 millisecond') else available_at end, " +
        "lease_owner = null, lease_expires_at = null, updated_at = now() where id = $1",
        [job.rows[0].workflow_task_id, terminal ? "failed" : "queued",
          retryable ? "transient" : "permanent", workflowCode, retryDelayMs]
      );
      await client.query(
        "update public.workflow_runs set status = $2, error_code = $3, updated_at = now() where id = $1",
        [runId, terminal ? "failed" : "queued", workflowCode]
      );
      await client.query(
        "select private.append_workflow_event($1, $2, $3, $4)",
        [runId, job.rows[0].workflow_task_id,
          terminal ? "task.failed" : "task.retry_scheduled", workflowCode]
      );
      if (terminal) {
        await client.query(
          "update private.website_authentication_checkpoints set state = 'failed', terminal_at = now(), updated_at = now() " +
          "where analysis_run_id = $1 and state = 'consumed'",
          [runId],
        );
        await client.query("select private.append_workflow_event($1, null, 'workflow.failed', $2)", [runId, workflowCode]);
      }
      return this.#workerAnalysis(client, runId);
    });
  }

  async getAnalysisResult(actor: RepositoryActor, runId: string): Promise<AnalysisResult | undefined> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const run = await client.query(
        "select result, release_code, release_hash, allowed_origin, release_manifest, provider_mode, " +
        "provider_adapter, provider_adapter_version, provider_fixture from public.analysis_runs " +
        "where id = $1 and organization_id = $2 and status = 'succeeded' limit 1",
        [runId, actor.organizationId]
      );
      if (!run.rows[0]) {
        await this.#analysis(client, actor, runId);
        return undefined;
      }
      const capabilities = await client.query(
        "select plan, status from public.capabilities " +
        "where analysis_run_id = $1 and organization_id = $2 order by stable_name limit $3",
        [runId, actor.organizationId, MAX_CAPABILITIES]
      );
      const evidence = await client.query(
        "select id, organization_id, project_id, analysis_run_id, source, content, reference, expires_at " +
        "from public.analysis_evidence where analysis_run_id = $1 and organization_id = $2 " +
        "and expires_at > now() order by created_at, id limit $3",
        [runId, actor.organizationId, MAX_EVIDENCE]
      );
      const stored = run.rows[0].result as {
        diagnostics?: AnalysisResult["diagnostics"];
        draftPullRequest?: AnalysisResult["draftPullRequest"];
      } | null;
      const diagnostics = normalizeAnalysisDiagnostics(stored?.diagnostics ?? []);
      const providerProvenance = run.rows[0].provider_mode === null ? undefined
        : normalizeProviderProvenance({
          mode: run.rows[0].provider_mode,
          adapter: run.rows[0].provider_adapter,
          adapterVersion: Number(run.rows[0].provider_adapter_version),
          fixture: run.rows[0].provider_fixture,
        } as never, run.rows[0].provider_mode === "local" ? "openapi" : run.rows[0].provider_mode as SourceType);
      const releaseValues = [run.rows[0].release_code, run.rows[0].release_hash,
        run.rows[0].allowed_origin, run.rows[0].release_manifest];
      const hasRelease = releaseValues.every((value) => value !== null && value !== undefined);
      if (releaseValues.some((value) => value !== null && value !== undefined) !== hasRelease
        || capabilities.rows.length === 0 && (diagnostics.length === 0 || hasRelease)
        || capabilities.rows.length > 0 && !hasRelease) {
        throw new RepositoryError("INVALID_STATE");
      }
      return {
        capabilities: capabilities.rows.map((row) => ({ plan: row.plan as CapabilityPlan,
          status: row.status as CapabilityRecord["status"] })),
        diagnostics,
        evidence: evidence.rows.map(mapEvidence),
        release: hasRelease ? { code: String(run.rows[0].release_code), contentHash: String(run.rows[0].release_hash),
          allowedOrigin: String(run.rows[0].allowed_origin), manifest: run.rows[0].release_manifest } : undefined,
        draftPullRequest: stored?.draftPullRequest,
        ...(providerProvenance ? { providerProvenance } : {}),
      };
    });
  }

  async listCapabilities(actor: RepositoryActor, projectId: string): Promise<CapabilityRecord[]> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      const result = await client.query(
        "select id, organization_id, project_id, analysis_run_id, stable_name, risk_tier, status, plan, " +
        "plan_digest, reviewed_plan_digest, version " +
        "from public.capabilities where project_id = $1 and organization_id = $2 order by stable_name, id limit $3",
        [projectId, actor.organizationId, MAX_CAPABILITIES]
      );
      return result.rows.map(mapCapability);
    });
  }

  async #analysisCapabilities(db: Db, actor: RepositoryActor, runId: string, lock: boolean): Promise<CapabilityRecord[]> {
    const result = await db.query(
      "select id, organization_id, project_id, analysis_run_id, stable_name, risk_tier, status, plan, " +
      "plan_digest, reviewed_plan_digest, version " +
      "from public.capabilities where analysis_run_id = $1 and organization_id = $2 " +
      "order by stable_name, id limit $3" + (lock ? " for update" : ""),
      [runId, actor.organizationId, MAX_CAPABILITIES]
    );
    return result.rows.map(mapCapability);
  }

  async listAnalysisCapabilities(actor: RepositoryActor, runId: string): Promise<CapabilityRecord[]> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#analysis(client, actor, runId);
      return this.#analysisCapabilities(client, actor, runId, false);
    });
  }

  async reviewCapability(actor: RepositoryActor, capabilityId: string, input: ReviewInput): Promise<CapabilityRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const result = await client.query(
        "select id, organization_id, project_id, analysis_run_id, stable_name, risk_tier, status, plan, " +
        "plan_digest, reviewed_plan_digest, version " +
        "from public.capabilities where id = $1 and organization_id = $2 for update",
        [capabilityId, actor.organizationId]
      );
      if (!result.rows[0]) throw new RepositoryError("NOT_FOUND");
      const capability = mapCapability(result.rows[0]);
      if (capability.version !== input.expectedVersion) throw new RepositoryError("VERSION_CONFLICT");
      if (input.action === "approve" && capability.riskTier === "R2" && actor.role !== "owner") {
        throw new RepositoryError("OWNER_APPROVAL_REQUIRED");
      }
      if (input.action === "approve") {
        if (!capabilityPlanBindingValid(capability)) {
          throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITY_PLAN_MISMATCH"]);
        }
        const evidence = await client.query(
          "select id, organization_id, project_id, analysis_run_id, source, content, reference, expires_at " +
          "from public.analysis_evidence where organization_id = $1 and project_id = $2 and analysis_run_id = $3 " +
          "and expires_at > now() order by reference",
          [actor.organizationId, capability.projectId, capability.analysisRunId]
        );
        if (!evidenceResolves(evidence.rows.map(mapEvidence), [capability.plan], actor.organizationId,
          capability.projectId, capability.analysisRunId, new Date())) {
          throw new RepositoryError("RELEASE_GATE_FAILED", ["EVIDENCE_MISSING_OR_EXPIRED"]);
        }
      }
      const nextStatus = input.action === "approve" ? "reviewed" : "blocked";
      await client.query(
        "insert into public.capability_reviews " +
        "(organization_id, project_id, capability_id, actor_id, action, capability_version, plan_digest) " +
        "values ($1,$2,$3,$4,$5,$6,$7)",
        [actor.organizationId, capability.projectId, capability.id, actor.id, input.action,
          input.expectedVersion, capability.planDigest]
      );
      const updated = await client.query(
        "update public.capabilities set status = $2, reviewed_plan_digest = plan_digest, version = version + 1 " +
        "where id = $1 and version = $3 returning id, organization_id, project_id, analysis_run_id, stable_name, " +
        "risk_tier, status, plan, plan_digest, reviewed_plan_digest, version",
        [capability.id, nextStatus, input.expectedVersion]
      );
      if (!updated.rows[0]) throw new RepositoryError("VERSION_CONFLICT");
      await this.#audit(client, actor, "capability." + input.action, capability.id);
      return mapCapability(updated.rows[0]);
    });
  }

  async saveVerification(
    actor: RepositoryActor,
    projectId: string,
    input: VerificationRequest
  ): Promise<VerificationRecord> {
    if (actor.role !== "owner") throw new RepositoryError("FORBIDDEN");
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      await this.#lockReleaseAnalysisRun(client, actor, projectId, input.analysisRunId);
      const run = await this.#analysis(client, actor, input.analysisRunId);
      if (run.projectId !== projectId || run.status !== "succeeded") throw new RepositoryError("INVALID_STATE");
      const capabilities = await this.#analysisCapabilities(client, actor, run.id, true);
      if (capabilities.some((capability) => !capabilityPlanBindingValid(capability))) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITY_PLAN_MISMATCH"]);
      }
      if (capabilityStateDigest(capabilities) !== input.capabilityStateDigest) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITIES_CHANGED"]);
      }
      const candidateBytes = Buffer.from(input.candidate.code);
      const candidateContentHash = createHash("sha256").update(candidateBytes).digest("hex");
      const candidateManifest = canonicalJson(input.candidate.manifest ?? {});
      if (candidateBytes.byteLength > MAX_RELEASE_BYTES || candidateContentHash !== input.candidate.contentHash
        || candidateManifest === "__INVALID_JSON__" || Buffer.byteLength(candidateManifest) > MAX_RELEASE_BYTES) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CANDIDATE_HASH_MISMATCH"]);
      }
      const candidatePlans = plansFromManifest(input.candidate.manifest);
      const selectedPlans = capabilities.filter(({ status }) => status !== "blocked").map(({ plan }) => plan);
      if (!candidatePlans || !equalPlanSets(candidatePlans, selectedPlans)) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITY_PLAN_MISMATCH"]);
      }
      const currentEvidence = await client.query(
        "select id, organization_id, project_id, analysis_run_id, source, content, reference, expires_at " +
        "from public.analysis_evidence where organization_id = $1 and project_id = $2 and analysis_run_id = $3 " +
        "and expires_at > now() order by reference",
        [actor.organizationId, projectId, run.id]
      );
      if (!evidenceResolves(currentEvidence.rows.map(mapEvidence), candidatePlans,
        actor.organizationId, projectId, run.id, new Date())) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["EVIDENCE_MISSING_OR_EXPIRED"]);
      }
      const published = await client.query(
        "select r.id, r.organization_id, r.project_id, r.analysis_run_id, r.capability_state_digest, " +
        "r.content_hash, r.sri, r.code, r.allowed_origin, r.manifest, r.verification_run_id, " +
        "r.artifact_url, r.download_url, r.local_only, " +
        "r.status, r.created_at " +
        "from public.releases r " +
        "where r.project_id = $1 and r.analysis_run_id = $2 limit 1",
        [projectId, run.id]
      );
      if (published.rows[0]) {
        const verification = await client.query(
          "select id, project_id, analysis_run_id, capability_state_digest, candidate_content_hash, schema_valid, " +
          "candidate_code, candidate_allowed_origin, candidate_manifest, authenticated, replay_passes, " +
          "no_secret_leakage, browser_execution, selection_score, checks, csp_result, verification_mode, " +
          "verifier_protocol_version, verifier_origin_digest, verifier_webmcp_implementation, observed_content_hash, " +
          "observed_integrity, observed_release_id, observed_target_origin, registered_tools, trusted_loader_enforced, " +
          "trusted_loader_content_hash, control_plane_request_count, model_request_count, " +
          "eligible, failures, created_at " +
          "from public.verification_runs where id = $1 and project_id = $2 and organization_id = $3 limit 1",
          [published.rows[0].verification_run_id, projectId, actor.organizationId]
        );
        const storedVerification = verification.rows[0] ? mapVerification(verification.rows[0]) : undefined;
        const publishedRelease = mapRelease(published.rows[0]);
        const persistedCandidate = verification.rows[0] ? mapVerificationCandidate(verification.rows[0]) : undefined;
        if (storedVerification?.eligible
          && persistedCandidate
          && candidateMatches(input.candidate, publishedRelease)
          && candidateMatches(input.candidate, persistedCandidate)) {
          return storedVerification;
        }
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CANDIDATE_CHANGED"]);
      }
      const failures = releaseFailures(input);
      const result = await client.query(
        "insert into public.verification_runs " +
        "(organization_id, project_id, analysis_run_id, capability_state_digest, candidate_content_hash, " +
        "candidate_code, candidate_allowed_origin, candidate_manifest, schema_valid, authenticated, replay_passes, " +
        "no_secret_leakage, browser_execution, selection_score, checks, csp_result, verification_mode, eligible, failures, " +
        "verifier_protocol_version, verifier_origin_digest, verifier_webmcp_implementation, observed_content_hash, " +
        "observed_integrity, observed_release_id, observed_target_origin, registered_tools, trusted_loader_enforced, " +
        "trusted_loader_content_hash, control_plane_request_count, model_request_count) " +
        "values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19," +
        "$20,$21,$22,$23,$24,$25,$26,$27::jsonb,$28,$29,$30,$31) " +
        "returning id, project_id, analysis_run_id, capability_state_digest, candidate_content_hash, schema_valid, authenticated, " +
        "replay_passes, no_secret_leakage, browser_execution, selection_score, checks, csp_result, verification_mode, " +
        "eligible, failures, verifier_protocol_version, verifier_origin_digest, verifier_webmcp_implementation, " +
        "observed_content_hash, observed_integrity, observed_release_id, observed_target_origin, registered_tools, " +
        "trusted_loader_enforced, trusted_loader_content_hash, control_plane_request_count, model_request_count, created_at",
        [actor.organizationId, projectId, input.analysisRunId, input.capabilityStateDigest, candidateContentHash,
          input.candidate.code, input.candidate.allowedOrigin, JSON.stringify(input.candidate.manifest ?? {}),
          input.schema, input.authenticated, input.replayPasses, input.noSecretLeakage, input.browserExecution,
          input.selectionScore, JSON.stringify(input.checks), JSON.stringify(input.csp), input.verificationMode,
          failures.length === 0, failures, input.verifierIdentity.protocolVersion,
          input.verifierIdentity.verifierOriginDigest, input.verifierIdentity.webMcpImplementation,
          input.observation.observedContentHash, input.observation.observedIntegrity,
          input.observation.observedReleaseId, input.observation.observedTargetOrigin,
          JSON.stringify(input.observation.registeredTools), input.observation.trustedLoader.enforcedBeforeEvaluation,
          input.observation.trustedLoader.evaluatedContentHash,
          input.observation.controlPlaneRequestsDuringExecution, input.observation.modelRequestsDuringExecution]
      );
      return mapVerification(result.rows[0]);
    });
  }

  async publishRelease(actor: RepositoryActor, input: PublishRequest): Promise<ReleaseRecord> {
    if (actor.role !== "owner") throw new RepositoryError("FORBIDDEN");
    const artifactIdentity = normalizeReleaseArtifactIdentity(input, input.candidateContentHash);
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, input.projectId);
      const proposedId = randomUUID();
      const replayId = await this.#reserveIdempotency(client, actor, "release", input.idempotencyKey, input.inputHash, proposedId);
      if (replayId) return this.#releaseById(client, actor, input, replayId);

      await this.#lockReleaseAnalysisRun(client, actor, input.projectId, input.analysisRunId);
      const run = await this.#analysis(client, actor, input.analysisRunId);
      if (run.projectId !== input.projectId || run.status !== "succeeded") throw new RepositoryError("INVALID_STATE");
      const capabilities = await this.#analysisCapabilities(client, actor, run.id, true);
      if (capabilities.some((capability) => !capabilityPlanBindingValid(capability))) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITY_PLAN_MISMATCH"]);
      }
      if (capabilityStateDigest(capabilities) !== input.capabilityStateDigest) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITIES_CHANGED"]);
      }
      const reviewFailures = capabilities.flatMap((capability) => {
        if ((capability.riskTier === "R1" || capability.riskTier === "R2")
          && capability.status !== "blocked"
          && (capability.status !== "reviewed" || capability.reviewedPlanDigest !== capability.planDigest)) {
          return ["REVIEW_REQUIRED"];
        }
        if (capability.status !== "blocked" && capability.reviewedPlanDigest !== capability.planDigest) {
          return ["CAPABILITY_PLAN_MISMATCH"];
        }
        return [];
      });
      if (reviewFailures.length > 0) throw new RepositoryError("RELEASE_GATE_FAILED", [...new Set(reviewFailures)]);

      const verification = await client.query(
        "select id, eligible, failures, candidate_content_hash, candidate_code, candidate_allowed_origin, candidate_manifest " +
        "from public.verification_runs where project_id = $1 and organization_id = $2 " +
        "and analysis_run_id = $3 and capability_state_digest = $4 order by revision desc, id desc limit 1",
        [input.projectId, actor.organizationId, input.analysisRunId, input.capabilityStateDigest]
      );
      if (!verification.rows[0]?.eligible) {
        throw new RepositoryError("RELEASE_GATE_FAILED", verification.rows[0]?.failures ?? ["VERIFICATION_MISSING"]);
      }
      if (String(verification.rows[0].id) !== input.verificationRunId
        || String(verification.rows[0].candidate_content_hash) !== input.candidateContentHash) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CANDIDATE_CHANGED"]);
      }
      const verifiedCandidate = mapVerificationCandidate(verification.rows[0]);
      const candidatePlans = plansFromManifest(verifiedCandidate.manifest);
      if (!candidatePlans
        || !equalPlanSets(candidatePlans, capabilities.filter(({ status }) => status !== "blocked").map(({ plan }) => plan))) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITY_PLAN_MISMATCH"]);
      }
      const evidence = await client.query(
        "select id, organization_id, project_id, analysis_run_id, source, content, reference, expires_at " +
        "from private.lock_current_analysis_evidence_rows($1, $2, $3)",
        [actor.organizationId, input.projectId, input.analysisRunId]
      );
      if (!evidenceResolves(evidence.rows.map(mapEvidence), candidatePlans, actor.organizationId,
        input.projectId, input.analysisRunId, new Date())) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["EVIDENCE_MISSING_OR_EXPIRED"]);
      }
      const existing = await client.query(
        "select id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, allowed_origin, " +
        "manifest, verification_run_id, artifact_url, download_url, local_only, status, created_at " +
        "from public.releases where project_id = $1 and analysis_run_id = $2 limit 1",
        [input.projectId, input.analysisRunId]
      );
      if (existing.rows[0]) {
        const existingRelease = mapRelease(existing.rows[0]);
        if (!releaseMatchesPublication(existingRelease, input)) throw new RepositoryError("INVALID_STATE");
        await client.query(
          "update private.idempotency_keys set result_id = $5 where organization_id = $1 and actor_id = $2 " +
          "and operation = 'release' and idempotency_key = $3 and input_hash = $4",
          [actor.organizationId, actor.id, input.idempotencyKey, input.inputHash, existing.rows[0].id]
        );
        return existingRelease;
      }
      const code = verifiedCandidate.code;
      const bytes = Buffer.from(code);
      if (bytes.byteLength > MAX_RELEASE_BYTES) throw new RepositoryError("INVALID_STATE");
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      if (contentHash !== input.candidateContentHash) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CANDIDATE_CHANGED"]);
      }
      const sri = "sha384-" + createHash("sha384").update(bytes).digest("base64");
      const release = await client.query(
        "insert into public.releases " +
        "(id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, allowed_origin, " +
        "manifest, verification_run_id, artifact_url, download_url, local_only, status) " +
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,'published') returning id, organization_id, project_id, " +
        "analysis_run_id, capability_state_digest, content_hash, sri, code, allowed_origin, manifest, artifact_url, " +
        "download_url, local_only, verification_run_id, status, created_at",
        [proposedId, actor.organizationId, input.projectId, input.analysisRunId, input.capabilityStateDigest,
          contentHash, sri, code, verifiedCandidate.allowedOrigin,
          JSON.stringify(verifiedCandidate.manifest ?? {}), input.verificationRunId,
          artifactIdentity.artifactUrl, artifactIdentity.downloadUrl, artifactIdentity.localOnly]
      );
      await this.#audit(client, actor, "release.published", proposedId);
      return mapRelease(release.rows[0]);
    });
  }

  async #releaseById(db: Db, actor: RepositoryActor, input: PublishRequest, id: string): Promise<ReleaseRecord> {
    const result = await db.query(
      "select id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, allowed_origin, " +
      "manifest, verification_run_id, artifact_url, download_url, local_only, status, created_at " +
      "from public.releases where id = $1 and organization_id = $2 " +
      "and project_id = $3 and analysis_run_id = $4 limit 1",
      [id, actor.organizationId, input.projectId, input.analysisRunId]
    );
    if (!result.rows[0]) throw new RepositoryError("INVALID_STATE");
    const release = mapRelease(result.rows[0]);
    if (!releaseMatchesPublication(release, input)) throw new RepositoryError("INVALID_STATE");
    return release;
  }

  async getReleaseArtifact(contentHash: string): Promise<ReleaseRecord> {
    return this.#transaction({ kind: "artifact" }, async (client) => {
      const result = await client.query(
        "select id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, allowed_origin, " +
        "manifest, verification_run_id, artifact_url, download_url, local_only, status, created_at " +
        "from public.releases where content_hash = $1 and status = 'published' " +
        "order by created_at, id limit 1",
        [contentHash]
      );
      if (!result.rows[0]) throw new RepositoryError("NOT_FOUND");
      return mapRelease(result.rows[0]);
    });
  }

  async getRelease(actor: RepositoryActor, projectId: string, releaseId: string): Promise<ReleaseRecord> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      const result = await client.query(
        "select id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, " +
        "allowed_origin, manifest, verification_run_id, artifact_url, download_url, local_only, status, created_at from public.releases " +
        "where id = $1 and project_id = $2 and organization_id = $3 limit 1",
        [releaseId, projectId, actor.organizationId]
      );
      if (!result.rows[0]) throw new RepositoryError("NOT_FOUND");
      return mapRelease(result.rows[0]);
    });
  }

  async getLatestPublishedRelease(
    actor: RepositoryActor,
    projectId: string,
  ): Promise<PublishedReleaseState | undefined> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      const releaseResult = await client.query(
        "select id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, " +
        "allowed_origin, manifest, verification_run_id, artifact_url, download_url, local_only, status, created_at from public.releases " +
        "where project_id = $1 and organization_id = $2 and status = 'published' " +
        "order by created_at desc, id desc limit 1",
        [projectId, actor.organizationId]
      );
      if (!releaseResult.rows[0]) return undefined;
      const release = mapRelease(releaseResult.rows[0]);
      if (!release.verificationRunId) return undefined;
      const verificationResult = await client.query(
        "select id, project_id, analysis_run_id, capability_state_digest, candidate_content_hash, schema_valid, " +
        "candidate_code, candidate_allowed_origin, candidate_manifest, authenticated, replay_passes, " +
        "no_secret_leakage, browser_execution, selection_score, checks, csp_result, verification_mode, " +
        "eligible, failures, verifier_protocol_version, verifier_origin_digest, verifier_webmcp_implementation, " +
        "observed_content_hash, observed_integrity, observed_release_id, observed_target_origin, registered_tools, " +
        "trusted_loader_enforced, trusted_loader_content_hash, control_plane_request_count, model_request_count, created_at " +
        "from public.verification_runs where id = $1 and project_id = $2 and organization_id = $3 " +
        "and analysis_run_id = $4 and capability_state_digest = $5 and candidate_content_hash = $6 and eligible " +
        "and candidate_code = $7 and candidate_allowed_origin = $8 and candidate_manifest = $9::jsonb " +
        "limit 1",
        [release.verificationRunId, projectId, actor.organizationId, release.analysisRunId,
          release.capabilityStateDigest, release.contentHash, release.code, release.allowedOrigin,
          JSON.stringify(release.manifest ?? {})]
      );
      if (!verificationResult.rows[0]) throw new RepositoryError("INVALID_STATE");
      const verification = mapVerification(verificationResult.rows[0]);
      const candidate = mapVerificationCandidate(verificationResult.rows[0]);
      if (!candidateMatches(candidate, release)) throw new RepositoryError("INVALID_STATE");
      return { release, verification };
    });
  }

  async getPreviousRelease(
    actor: RepositoryActor,
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | undefined> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      const current = await client.query(
        "select id, created_at from public.releases where id = $1 and project_id = $2 and organization_id = $3 limit 1",
        [releaseId, projectId, actor.organizationId]
      );
      if (!current.rows[0]) throw new RepositoryError("NOT_FOUND");
      const result = await client.query(
        "select id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, " +
        "allowed_origin, manifest, verification_run_id, artifact_url, download_url, local_only, status, created_at " +
        "from public.releases where project_id = $1 and organization_id = $2 " +
        "and (created_at, id) < ($3::timestamptz, $4::uuid) order by created_at desc, id desc limit 1",
        [projectId, actor.organizationId, current.rows[0].created_at, releaseId]
      );
      return result.rows[0] ? mapRelease(result.rows[0]) : undefined;
    });
  }

  async saveReleaseInstallation(
    actor: RepositoryActor,
    projectId: string,
    input: ReleaseInstallationRequest,
  ): Promise<ReleaseInstallationRecord> {
    if (actor.role !== "owner") throw new RepositoryError("FORBIDDEN");
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      const releaseResult = await client.query(
        "select id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, " +
        "allowed_origin, manifest, artifact_url, download_url, local_only, status, created_at from public.releases " +
        "where id = $1 and project_id = $2 and organization_id = $3 limit 1",
        [input.releaseId, projectId, actor.organizationId]
      );
      if (!releaseResult.rows[0]) throw new RepositoryError("NOT_FOUND");
      const normalized = normalizeReleaseInstallation(input, mapRelease(releaseResult.rows[0]));
      const executionEvidence = normalized.attestation.executionEvidence;
      const keyed = await client.query(
        `select ${RELEASE_INSTALLATION_COLUMNS} ` +
        "from public.release_installations where organization_id = $1 and actor_id = $2 and idempotency_key = $3 limit 1",
        [actor.organizationId, actor.id, input.idempotencyKey]
      );
      if (keyed.rows[0]) {
        const replay = mapReleaseInstallation(keyed.rows[0]);
        if (replay.projectId !== projectId || replay.releaseId !== input.releaseId || replay.inputHash !== input.inputHash) {
          throw new RepositoryError("IDEMPOTENCY_CONFLICT");
        }
        return replay;
      }
      const result = await client.query(
        "insert into public.release_installations " +
        "(organization_id, project_id, release_id, actor_id, page_url, artifact_url, self_hosted_url, target_origin, " +
        "artifact_content_hash, integrity, expected_tools, status, delivery, csp_status, csp_directive, " +
        "webmcp_implementation, attestation, idempotency_key, input_hash, download_url, local_only, verification_mode, " +
        "verifier_protocol_version, verifier_origin_digest, verifier_webmcp_implementation, observed_artifact_url, " +
        "observed_download_url, observed_local_only, observed_integrity, observed_target_origin, registered_tools, " +
        "executed_artifact_url, served_content_hash, executed_content_hash, normal_page_load, route_interception, " +
        "injected_registration, synthetic_harness, duplicate_load_harmless, authenticated_read_tool_name, " +
        "authenticated_read_authenticated, authenticated_read_succeeded, confirmed_mutation_tool_name, " +
        "confirmed_mutation_confirmation, confirmed_mutation_reversible, confirmed_mutation_succeeded, " +
        "confirmed_mutation_effect_count, final_state_mutation_tool_name, final_state_source, final_state_verified, " +
        "verified_at) " +
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17::jsonb,$18,$19," +
        "$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::jsonb,$32,$33,$34,$35,$36,$37,$38,$39," +
        "$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50," +
        "case when $12 = 'verified' then now() else null end) " +
        "on conflict (organization_id, actor_id, idempotency_key) do nothing " +
        `returning ${RELEASE_INSTALLATION_COLUMNS}`,
        [actor.organizationId, projectId, input.releaseId, actor.id, normalized.pageUrl, normalized.artifactUrl,
          normalized.selfHostedUrl ?? null, normalized.targetOrigin, normalized.artifactContentHash, normalized.integrity,
          JSON.stringify(normalized.expectedTools), normalized.status, normalized.delivery, normalized.csp.hosted,
          normalized.csp.directive ?? null, normalized.webMcpImplementation, JSON.stringify(normalized.attestation),
          normalized.idempotencyKey, normalized.inputHash, normalized.downloadUrl, normalized.localOnly,
          normalized.verifierIdentity.mode, normalized.verifierIdentity.protocolVersion,
          normalized.verifierIdentity.verifierOriginDigest, normalized.verifierIdentity.webMcpImplementation,
          normalized.attestation.observedArtifactUrl, normalized.attestation.observedDownloadUrl,
          normalized.attestation.observedLocalOnly, normalized.attestation.observedIntegrity,
          normalized.attestation.observedTargetOrigin, JSON.stringify(normalized.attestation.registeredTools),
          normalized.attestation.executedArtifactUrl, normalized.attestation.servedContentHash,
          normalized.attestation.executedContentHash, normalized.attestation.normalPageLoad,
          normalized.attestation.routeInterception, normalized.attestation.injectedRegistration,
          normalized.attestation.syntheticHarness, normalized.attestation.duplicateLoadHarmless,
          executionEvidence?.authenticatedRead.toolName ?? null,
          executionEvidence?.authenticatedRead.authenticated ?? null,
          executionEvidence?.authenticatedRead.succeeded ?? null,
          executionEvidence?.confirmedReversibleMutation.toolName ?? null,
          executionEvidence?.confirmedReversibleMutation.confirmation ?? null,
          executionEvidence?.confirmedReversibleMutation.reversible ?? null,
          executionEvidence?.confirmedReversibleMutation.succeeded ?? null,
          executionEvidence?.confirmedReversibleMutation.effectCount ?? null,
          executionEvidence?.authoritativeFinalState.mutationToolName ?? null,
          executionEvidence?.authoritativeFinalState.source ?? null,
          executionEvidence?.authoritativeFinalState.verified ?? null]
      );
      if (result.rows[0]) return mapReleaseInstallation(result.rows[0]);
      const existing = await client.query(
        `select ${RELEASE_INSTALLATION_COLUMNS} ` +
        "from public.release_installations where organization_id = $1 and actor_id = $2 and idempotency_key = $3 limit 1",
        [actor.organizationId, actor.id, input.idempotencyKey]
      );
      const record = existing.rows[0] ? mapReleaseInstallation(existing.rows[0]) : undefined;
      if (!record || record.projectId !== projectId || record.releaseId !== input.releaseId
        || record.inputHash !== input.inputHash) {
        throw new RepositoryError("IDEMPOTENCY_CONFLICT");
      }
      return record;
    });
  }

  async getLatestReleaseInstallation(
    actor: RepositoryActor,
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseInstallationRecord | undefined> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      await this.#project(client, actor, projectId);
      const release = await client.query(
        "select id from public.releases where id = $1 and project_id = $2 and organization_id = $3 limit 1",
        [releaseId, projectId, actor.organizationId],
      );
      if (!release.rows[0]) throw new RepositoryError("NOT_FOUND");
      const result = await client.query(
        `select ${RELEASE_INSTALLATION_COLUMNS} from public.release_installations ` +
        "where release_id = $1 and project_id = $2 and organization_id = $3 " +
        "order by created_at desc, id desc limit 1",
        [releaseId, projectId, actor.organizationId],
      );
      return result.rows[0] ? mapReleaseInstallation(result.rows[0]) : undefined;
    });
  }

  async listAuditEvents(actor: RepositoryActor): Promise<AuditEventRecord[]> {
    if (actor.role !== "owner") throw new RepositoryError("FORBIDDEN");
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const result = await client.query(
        "select id, organization_id, actor_id, action, target_id, created_at from public.audit_events " +
        "where organization_id = $1 and expires_at > now() order by created_at, id limit $2",
        [actor.organizationId, MAX_AUDIT_EVENTS]
      );
      return result.rows.map((row) => ({ id: String(row.id), organizationId: String(row.organization_id),
        actorId: String(row.actor_id), action: String(row.action), targetId: String(row.target_id), createdAt: iso(row.created_at) }));
    });
  }

  async reset(): Promise<void> {
    if (process.env.NODE_ENV !== "test") throw new RepositoryError("FORBIDDEN");
    await this.#pool.query(
      "truncate public.github_draft_pull_requests, public.release_installations, public.installations, public.verification_checks, public.capability_plans, public.workflow_evidence, " +
      "public.workflow_events, private.workflow_commands, private.workflow_tasks, public.workflow_runs, " +
      "public.source_snapshots, public.project_sources, public.audit_events, public.releases, " +
      "public.verification_runs, public.capability_reviews, " +
      "public.analysis_evidence, public.capabilities, private.analysis_jobs, private.idempotency_keys, " +
      "public.analysis_runs, public.projects restart identity cascade"
    );
  }

  async close(): Promise<void> { await this.#pool.end(); }
}

export function createPostgresRepository(options: PostgresOptions): PostgresControlPlaneRepository {
  if (!options.connectionString) throw new Error("DATABASE_URL_REQUIRED");
  return new PostgresControlPlaneRepository(options);
}

function mapProject(row: QueryResultRow): ProjectRecord {
  return { id: String(row.id), organizationId: String(row.organization_id), createdBy: String(row.created_by),
    name: String(row.name), sourceType: row.source_type as SourceType, url: String(row.source_url),
    status: row.status as ProjectRecord["status"], createdAt: iso(row.created_at) };
}

function mapActor(row: QueryResultRow): RepositoryActor {
  const role = String(row.role);
  if (role !== "owner" && role !== "editor" && role !== "viewer") {
    throw new RepositoryError("MEMBERSHIP_REQUIRED");
  }
  return { id: String(row.user_id), organizationId: String(row.organization_id), role };
}

type ProjectCursor = Readonly<{ createdAt: string; id: string }>;

function encodeProjectCursor(project: ProjectRecord): string {
  return Buffer.from(JSON.stringify({ createdAt: project.createdAt, id: project.id })).toString("base64url");
}

function decodeProjectCursor(value: string): ProjectCursor {
  if (!/^[A-Za-z0-9_-]{8,512}$/.test(value)) throw new RepositoryError("INVALID_CURSOR");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort(compareStrings).join(",") !== "createdAt,id") {
      throw new RepositoryError("INVALID_CURSOR");
    }
    const cursor = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))
      || typeof cursor.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)) {
      throw new RepositoryError("INVALID_CURSOR");
    }
    return { createdAt: new Date(cursor.createdAt).toISOString(), id: cursor.id };
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("INVALID_CURSOR");
  }
}

function mapAnalysis(row: QueryResultRow): AnalysisRunRecord {
  const sourceType = row.provider_mode === "openapi" || row.provider_mode === "website" || row.provider_mode === "github"
    ? row.provider_mode as SourceType : "openapi";
  const provenance = row.provider_mode === null || row.provider_mode === undefined ? undefined
    : normalizeProviderProvenance({
      mode: row.provider_mode,
      adapter: row.provider_adapter,
      adapterVersion: Number(row.provider_adapter_version),
      fixture: row.provider_fixture,
    } as never, sourceType);
  return { id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    requestedBy: String(row.requested_by), status: row.status as AnalysisRunRecord["status"], attempts: Number(row.attempts),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : undefined,
    errorCode: row.error_code ? String(row.error_code) : undefined,
    ...(provenance ? { providerProvenance: provenance } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapClaimedAnalysis(row: QueryResultRow): ClaimedAnalysisRunRecord {
  const checkpoint = row.authentication_checkpoint_reference
    ? {
        checkpointReference: String(row.authentication_checkpoint_reference),
        authenticationEvidenceReference: String(row.authentication_evidence_reference),
        sourceSnapshotId: String(row.authentication_source_snapshot_id),
        sourceIdentityHash: String(row.authentication_source_identity_hash),
        targetOriginDigest: String(row.authentication_target_origin_digest),
        expiresAt: iso(row.authentication_expires_at),
      }
    : undefined;
  return {
    ...mapAnalysis(row),
    sourceType: row.source_type as SourceType,
    sourceUrl: String(row.source_url),
    sourceConfiguration: parsePersistedSourceConfiguration(
      row.source_type as SourceType,
      row.source_configuration as SourceConfiguration,
    ),
    workflowTaskId: String(row.workflow_task_id),
    sourceSnapshotId: String(row.source_snapshot_id),
    leaseGeneration: Number(row.lease_generation),
    ...(checkpoint ? { authenticationCheckpoint: checkpoint } : {}),
  };
}

function mapWebsiteAuthenticationCheckpoint(row: QueryResultRow): WebsiteAuthenticationCheckpointRecord {
  return {
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    analysisRunId: String(row.analysis_run_id),
    workflowTaskId: String(row.workflow_task_id),
    sourceSnapshotId: String(row.source_snapshot_id),
    sourceIdentityHash: String(row.source_identity_hash),
    targetOriginDigest: String(row.target_origin_digest),
    checkpointReference: String(row.checkpoint_reference),
    ...(row.authentication_evidence_reference
      ? { authenticationEvidenceReference: String(row.authentication_evidence_reference) }
      : {}),
    state: row.state as WebsiteAuthenticationCheckpointRecord["state"],
    expiresAt: iso(row.expires_at),
    ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
    ...(row.terminal_at ? { terminalAt: iso(row.terminal_at) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapProjectSource(row: QueryResultRow): ProjectSourceRecord {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    sourceType: row.source_type as ProjectSourceRecord["sourceType"], sourceUrl: String(row.source_url),
    sourceConfiguration: parsePersistedSourceConfiguration(
      row.source_type as SourceType,
      row.source_configuration as SourceConfiguration,
    ),
    version: Number(row.version), active: Boolean(row.active), createdAt: iso(row.created_at),
  };
}

function mapSourceSnapshot(row: QueryResultRow): SourceSnapshotRecord {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    projectSourceId: String(row.project_source_id), sourceIdentityHash: String(row.source_identity_hash),
    ...(row.artifact_reference ? { artifactReference: String(row.artifact_reference) } : {}),
    ...(row.content_hash ? { contentHash: String(row.content_hash) } : {}),
    isFixture: row.is_fixture === false ? false : true,
    createdAt: iso(row.created_at),
  };
}

function mapWorkflowRun(row: QueryResultRow): WorkflowRunRecord {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    sourceSnapshotId: String(row.source_snapshot_id),
    ...(row.analysis_run_id ? { analysisRunId: String(row.analysis_run_id) } : {}),
    ...(row.reviewed_analysis_run_id ? { reviewedAnalysisRunId: String(row.reviewed_analysis_run_id) } : {}),
    status: row.status as WorkflowRunRecord["status"], currentPhase: row.current_phase as WorkflowRunRecord["currentPhase"],
    inputHash: String(row.input_hash), version: Number(row.version),
    ...(row.cancel_requested_at ? { cancelRequestedAt: iso(row.cancel_requested_at) } : {}),
    ...(row.cancelled_at ? { cancelledAt: iso(row.cancelled_at) } : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function mapWorkflowTask(row: QueryResultRow): WorkflowTaskRecord {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    workflowRunId: String(row.workflow_run_id), phase: row.phase as WorkflowTaskRecord["phase"],
    status: row.status as WorkflowTaskRecord["status"], idempotencyKey: String(row.idempotency_key),
    inputHash: String(row.input_hash),
    ...(row.output_hash ? { outputHash: String(row.output_hash) } : {}),
    ...(row.checkpoint_reference ? { checkpointReference: String(row.checkpoint_reference) } : {}),
    ...(row.output_reference ? { outputReference: String(row.output_reference) } : {}),
    ...(row.wait_key_hash ? { waitKeyHash: String(row.wait_key_hash) } : {}),
    ...(row.wait_reason ? { waitReason: String(row.wait_reason) } : {}),
    ...(row.wait_expires_at ? { waitExpiresAt: iso(row.wait_expires_at) } : {}),
    ...(row.resumed_at ? { resumedAt: iso(row.resumed_at) } : {}),
    ...(row.cancel_requested_at ? { cancelRequestedAt: iso(row.cancel_requested_at) } : {}),
    ...(row.cancelled_at ? { cancelledAt: iso(row.cancelled_at) } : {}),
    leaseGeneration: Number(row.lease_generation),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts),
    ...(row.retry_classification ? { retryClassification: row.retry_classification as WorkflowTaskRecord["retryClassification"] } : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    availableAt: iso(row.available_at),
    ...(row.reconciled_at ? { reconciledAt: iso(row.reconciled_at) } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function mapWorkflowEvent(row: QueryResultRow): WorkflowEventRecord {
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as WorkflowEventRecord["payload"]
    : undefined;
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    workflowRunId: String(row.workflow_run_id), ...(row.task_id ? { taskId: String(row.task_id) } : {}),
    sequence: Number(row.sequence), version: Number(row.version), type: row.event_type as WorkflowEventRecord["type"],
    ...(row.code ? { code: String(row.code) } : {}),
    ...(payload && Object.keys(payload).length > 0 ? { payload } : {}),
    createdAt: iso(row.created_at),
  };
}

function mapWorkflowEvidence(row: QueryResultRow): WorkflowEvidenceLink {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    workflowRunId: String(row.workflow_run_id), taskId: String(row.task_id),
    ...(row.evidence_id ? { evidenceId: String(row.evidence_id) } : {}),
    reference: String(row.reference), createdAt: iso(row.created_at),
  };
}

function mapWorkflowCapabilityPlan(row: QueryResultRow): WorkflowCapabilityPlanLink {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    workflowRunId: String(row.workflow_run_id), taskId: String(row.task_id), capabilityId: String(row.capability_id),
    planDigest: String(row.plan_digest), createdAt: iso(row.created_at),
  };
}

function mapCapability(row: QueryResultRow): CapabilityRecord {
  return { id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    analysisRunId: String(row.analysis_run_id), stableName: String(row.stable_name),
    riskTier: row.risk_tier as CapabilityRecord["riskTier"], status: row.status as CapabilityRecord["status"],
    plan: row.plan as CapabilityPlan, planDigest: String(row.plan_digest),
    reviewedPlanDigest: row.reviewed_plan_digest === null || row.reviewed_plan_digest === undefined
      ? undefined : String(row.reviewed_plan_digest),
    version: Number(row.version) };
}

function mapEvidence(row: QueryResultRow): AnalysisEvidence {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    analysisRunId: String(row.analysis_run_id),
    source: row.source as AnalysisEvidence["source"],
    content: String(row.content),
    reference: String(row.reference),
    expiresAt: iso(row.expires_at),
  };
}

function mapVerification(row: QueryResultRow): VerificationRecord {
  const provenance = row.verifier_protocol_version === null || row.verifier_protocol_version === undefined ? {} : {
    verifierIdentity: {
      protocolVersion: Number(row.verifier_protocol_version) as 1,
      mode: row.verification_mode as "hermetic" | "local_live" | "live",
      webMcpImplementation: row.verifier_webmcp_implementation as "native",
      verifierOriginDigest: String(row.verifier_origin_digest),
    },
    observation: {
      observedContentHash: String(row.observed_content_hash),
      observedIntegrity: String(row.observed_integrity),
      observedReleaseId: String(row.observed_release_id),
      observedTargetOrigin: String(row.observed_target_origin),
      registeredTools: row.registered_tools as string[],
      trustedLoader: {
        enforcedBeforeEvaluation: Boolean(row.trusted_loader_enforced),
        evaluatedContentHash: String(row.trusted_loader_content_hash),
      },
      controlPlaneRequestsDuringExecution: Number(row.control_plane_request_count),
      modelRequestsDuringExecution: Number(row.model_request_count),
    },
  };
  return { id: String(row.id), projectId: String(row.project_id), analysisRunId: String(row.analysis_run_id),
    capabilityStateDigest: String(row.capability_state_digest), schema: Boolean(row.schema_valid),
    candidateContentHash: String(row.candidate_content_hash),
    authenticated: Boolean(row.authenticated), replayPasses: Number(row.replay_passes),
    noSecretLeakage: Boolean(row.no_secret_leakage), browserExecution: Boolean(row.browser_execution),
    selectionScore: Number(row.selection_score), checks: row.checks as VerificationRecord["checks"],
    csp: row.csp_result as VerificationRecord["csp"], verificationMode: row.verification_mode as VerificationRecord["verificationMode"],
    eligible: Boolean(row.eligible), failures: row.failures as string[], ...provenance,
    createdAt: iso(row.created_at) };
}

function mapGitHubDraftPullRequest(row: QueryResultRow): GitHubDraftPullRequestRecord {
  const status = String(row.check_status);
  const conclusion = row.check_conclusion === null || row.check_conclusion === undefined
    ? undefined : String(row.check_conclusion);
  if (!["publish", "install_verify"].includes(String(row.phase))
    || !["queued", "in_progress", "completed"].includes(status)
    || conclusion !== undefined && ![
      "action_required", "cancelled", "failure", "neutral", "success", "skipped", "stale", "timed_out",
    ].includes(conclusion)
    || row.draft !== true || row.merged !== false) throw new RepositoryError("INVALID_STATE");
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    workflowRunId: String(row.workflow_run_id),
    taskId: String(row.task_id),
    analysisRunId: String(row.analysis_run_id),
    sourceSnapshotId: String(row.source_snapshot_id),
    projectSourceId: String(row.project_source_id),
    phase: row.phase as GitHubDraftPullRequestRecord["phase"],
    installationId: Number(row.installation_id),
    repositoryId: Number(row.repository_id),
    owner: String(row.owner),
    repository: String(row.repository),
    requestedRef: String(row.requested_ref),
    baseCommitSha: String(row.base_commit_sha),
    patchDigest: String(row.patch_digest),
    branch: String(row.branch),
    number: Number(row.pull_request_number),
    url: String(row.pull_request_url),
    headCommitSha: String(row.head_commit_sha),
    draft: true,
    merged: false,
    check: {
      externalId: String(row.check_external_id),
      status: status as GitHubDraftPullRequestRecord["check"]["status"],
      ...(conclusion ? { conclusion: conclusion as NonNullable<GitHubDraftPullRequestRecord["check"]["conclusion"]> } : {}),
    },
    sandboxReference: String(row.sandbox_reference),
    ...(row.preview_reference ? { previewReference: String(row.preview_reference) } : {}),
    sideEffectIdempotencyKey: String(row.side_effect_idempotency_key),
    sideEffectInputHash: String(row.side_effect_input_hash),
    outputHash: String(row.output_hash),
    outputReference: String(row.output_reference),
    createdAt: iso(row.created_at),
  };
}

function mapReleaseInstallation(row: QueryResultRow): ReleaseInstallationRecord {
  const hasNativeObservation = row.verifier_protocol_version !== null
    && row.verifier_protocol_version !== undefined;
  if (!hasNativeObservation || typeof row.download_url !== "string" || typeof row.local_only !== "boolean") {
    throw new RepositoryError("INVALID_STATE");
  }
  const verifierIdentity = {
    protocolVersion: Number(row.verifier_protocol_version) as 1,
    mode: row.verification_mode as "hermetic" | "local_live" | "live",
    webMcpImplementation: row.verifier_webmcp_implementation as "native",
    verifierOriginDigest: String(row.verifier_origin_digest),
  };
  const executionColumns = [
    row.authenticated_read_tool_name,
    row.authenticated_read_authenticated,
    row.authenticated_read_succeeded,
    row.confirmed_mutation_tool_name,
    row.confirmed_mutation_confirmation,
    row.confirmed_mutation_reversible,
    row.confirmed_mutation_succeeded,
    row.confirmed_mutation_effect_count,
    row.final_state_mutation_tool_name,
    row.final_state_source,
    row.final_state_verified,
  ];
  const hasExecutionEvidence = executionColumns.every((value) => value !== null && value !== undefined);
  if (!hasExecutionEvidence && executionColumns.some((value) => value !== null && value !== undefined)) {
    throw new RepositoryError("INVALID_STATE");
  }
  if (hasExecutionEvidence && (
    typeof row.authenticated_read_tool_name !== "string"
    || !/^[a-z][a-z0-9_]{0,63}$/.test(row.authenticated_read_tool_name)
    || row.authenticated_read_authenticated !== true
    || row.authenticated_read_succeeded !== true
    || typeof row.confirmed_mutation_tool_name !== "string"
    || !/^[a-z][a-z0-9_]{0,63}$/.test(row.confirmed_mutation_tool_name)
    || row.confirmed_mutation_tool_name === row.authenticated_read_tool_name
    || row.confirmed_mutation_confirmation !== "explicit"
    || row.confirmed_mutation_reversible !== true
    || row.confirmed_mutation_succeeded !== true
    || row.confirmed_mutation_effect_count !== 1
    || row.final_state_mutation_tool_name !== row.confirmed_mutation_tool_name
    || row.final_state_source !== "target"
    || row.final_state_verified !== true
  )) throw new RepositoryError("INVALID_STATE");
  const executionEvidence = hasExecutionEvidence ? {
    authenticatedRead: {
      toolName: row.authenticated_read_tool_name as string,
      authenticated: row.authenticated_read_authenticated as true,
      succeeded: row.authenticated_read_succeeded as true,
    },
    confirmedReversibleMutation: {
      toolName: row.confirmed_mutation_tool_name as string,
      confirmation: row.confirmed_mutation_confirmation as "explicit",
      reversible: row.confirmed_mutation_reversible as true,
      succeeded: row.confirmed_mutation_succeeded as true,
      effectCount: row.confirmed_mutation_effect_count as 1,
    },
    authoritativeFinalState: {
      mutationToolName: row.final_state_mutation_tool_name as string,
      source: row.final_state_source as "target",
      verified: row.final_state_verified as true,
    },
  } : null;
  const attestation = {
    observedArtifactUrl: String(row.observed_artifact_url),
    observedDownloadUrl: String(row.observed_download_url),
    observedLocalOnly: Boolean(row.observed_local_only),
    observedIntegrity: String(row.observed_integrity),
    executedArtifactUrl: row.executed_artifact_url === null ? null : String(row.executed_artifact_url),
    servedContentHash: String(row.served_content_hash),
    executedContentHash: row.executed_content_hash === null ? null : String(row.executed_content_hash),
    observedTargetOrigin: String(row.observed_target_origin),
    registeredTools: row.registered_tools as string[],
    webMcpImplementation: row.webmcp_implementation as "native" | "compatibility_shim",
    normalPageLoad: Boolean(row.normal_page_load),
    routeInterception: Boolean(row.route_interception),
    injectedRegistration: Boolean(row.injected_registration),
    syntheticHarness: Boolean(row.synthetic_harness),
    duplicateLoadHarmless: row.duplicate_load_harmless === null
      ? null : Boolean(row.duplicate_load_harmless),
    executionEvidence,
    csp: {
      hosted: row.csp_status as "allowed" | "blocked",
      ...(row.csp_directive ? { directive: String(row.csp_directive) } : {}),
    },
  };
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    releaseId: String(row.release_id), actorId: String(row.actor_id), pageUrl: String(row.page_url),
    artifactUrl: String(row.artifact_url), ...(row.self_hosted_url ? { selfHostedUrl: String(row.self_hosted_url) } : {}),
    downloadUrl: String(row.download_url), localOnly: Boolean(row.local_only),
    targetOrigin: String(row.target_origin), artifactContentHash: String(row.artifact_content_hash),
    integrity: String(row.integrity), expectedTools: row.expected_tools as string[],
    status: row.status as ReleaseInstallationRecord["status"], delivery: row.delivery as ReleaseInstallationRecord["delivery"],
    csp: { hosted: row.csp_status as "allowed" | "blocked",
      ...(row.csp_directive ? { directive: String(row.csp_directive) } : {}) },
    webMcpImplementation: row.webmcp_implementation as ReleaseInstallationRecord["webMcpImplementation"],
    verifierIdentity,
    attestation,
    idempotencyKey: String(row.idempotency_key), inputHash: String(row.input_hash),
    createdAt: iso(row.created_at), ...(row.verified_at ? { verifiedAt: iso(row.verified_at) } : {}),
  };
}

function mapVerificationCandidate(row: QueryResultRow): CandidateRelease {
  return {
    code: String(row.candidate_code),
    contentHash: String(row.candidate_content_hash),
    allowedOrigin: String(row.candidate_allowed_origin),
    manifest: row.candidate_manifest
  };
}

function mapRelease(row: QueryResultRow): ReleaseRecord {
  const release = { id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    analysisRunId: String(row.analysis_run_id), capabilityStateDigest: String(row.capability_state_digest),
    contentHash: String(row.content_hash), sri: String(row.sri),
    code: String(row.code), allowedOrigin: String(row.allowed_origin), manifest: row.manifest,
    ...(row.verification_run_id ? { verificationRunId: String(row.verification_run_id) } : {}),
    status: "published" as const, createdAt: iso(row.created_at) };
  const values = [row.artifact_url, row.download_url, row.local_only];
  if (values.every((value) => value === null || value === undefined)) return release;
  if (values.some((value) => value === null || value === undefined) || typeof row.local_only !== "boolean") {
    throw new RepositoryError("INVALID_STATE");
  }
  return {
    ...release,
    ...normalizeReleaseArtifactIdentity({
      artifactUrl: String(row.artifact_url),
      downloadUrl: String(row.download_url),
      localOnly: row.local_only,
    }, release.contentHash),
  };
}

function releaseMatchesPublication(release: ReleaseRecord, input: PublishRequest): boolean {
  let artifactIdentity: ReturnType<typeof persistedReleaseArtifactIdentity>;
  try {
    artifactIdentity = persistedReleaseArtifactIdentity(release);
  } catch {
    return false;
  }
  return release.projectId === input.projectId
    && release.analysisRunId === input.analysisRunId
    && release.capabilityStateDigest === input.capabilityStateDigest
    && release.contentHash === input.candidateContentHash
    && release.verificationRunId === input.verificationRunId
    && artifactIdentity !== undefined
    && artifactIdentity.artifactUrl === input.artifactUrl
    && artifactIdentity.downloadUrl === input.downloadUrl
    && artifactIdentity.localOnly === input.localOnly;
}

function candidateMatches(candidate: CandidateRelease, stored: CandidateRelease): boolean {
  return candidate.code === stored.code
    && candidate.contentHash === stored.contentHash
    && candidate.allowedOrigin === stored.allowedOrigin
    && canonicalJson(candidate.manifest ?? {}) === canonicalJson(stored.manifest ?? {});
}

function plansFromManifest(manifest: unknown): readonly CapabilityPlan[] | undefined {
  if (!manifest || typeof manifest !== "object" || !("plans" in manifest)
    || !Array.isArray((manifest as { plans?: unknown }).plans)) return undefined;
  try {
    return canonicalizeCapabilityPlans((manifest as { plans: CapabilityPlan[] }).plans);
  } catch {
    return undefined;
  }
}

function equalPlanSets(left: readonly CapabilityPlan[], right: readonly CapabilityPlan[]): boolean {
  if (left.length !== right.length) return false;
  const leftDigests = left.map((plan) => `${plan.tool.name}:${capabilityPlanDigest(plan)}`).sort(compareStrings);
  const rightDigests = right.map((plan) => `${plan.tool.name}:${capabilityPlanDigest(plan)}`).sort(compareStrings);
  return leftDigests.every((value, index) => value === rightDigests[index]);
}

function capabilityPlanBindingValid(capability: CapabilityRecord): boolean {
  try {
    return capability.stableName === capability.plan.tool.name
      && capability.riskTier === capability.plan.effects.riskTier
      && capability.planDigest === capabilityPlanDigest(capability.plan);
  } catch {
    return false;
  }
}

function normalizeEvidence(
  evidence: AnalysisEvidence,
  organizationId: string,
  projectId: string,
  analysisRunId: string,
): Required<AnalysisEvidence> {
  const now = new Date();
  if (!evidence || typeof evidence !== "object"
    || !["openapi", "github", "runtime", "owner_review", "source"].includes(evidence.source)
    || typeof evidence.content !== "string" || evidence.content.length === 0
    || Buffer.byteLength(evidence.content) > MAX_RELEASE_BYTES
    || evidence.organizationId !== undefined && evidence.organizationId !== organizationId
    || evidence.projectId !== undefined && evidence.projectId !== projectId
    || evidence.analysisRunId !== undefined && evidence.analysisRunId !== analysisRunId) {
    throw new RepositoryError("INVALID_STATE");
  }
  const reference = `urn:sha256:${createHash("sha256").update(evidence.content).digest("hex")}`;
  const expiresAt = evidence.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  if (evidence.reference !== reference || !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt) <= now) {
    throw new RepositoryError("INVALID_STATE");
  }
  return {
    id: evidence.id ?? randomUUID(),
    organizationId,
    projectId,
    analysisRunId,
    source: evidence.source,
    content: evidence.content,
    reference,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function evidenceResolves(
  evidence: readonly AnalysisEvidence[],
  plans: readonly CapabilityPlan[],
  organizationId: string,
  projectId: string,
  analysisRunId: string,
  now: Date,
): boolean {
  const byReference = new Map<string, AnalysisEvidence>();
  for (const item of evidence) {
    if (item.organizationId !== organizationId || item.projectId !== projectId
      || item.analysisRunId !== analysisRunId || item.expiresAt === undefined || new Date(item.expiresAt) <= now
      || `urn:sha256:${createHash("sha256").update(item.content).digest("hex")}` !== item.reference
      || byReference.has(item.reference)) return false;
    byReference.set(item.reference, item);
  }
  return plans.every((plan) => plan.evidence.every(({ source, reference }) => {
    const resolved = byReference.get(reference);
    return resolved?.source === source;
  }));
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort(compareStrings).map((key) => [key, normalize(record[key])]));
    }
    return item;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return "__INVALID_JSON__";
  }
}

function stableHash(value: string): string {
  return /^[0-9a-f]{64}$/.test(value)
    ? value
    : createHash("sha256").update(value, "utf8").digest("hex");
}

function stableHashBounded(value: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new RepositoryError("INVALID_STATE");
  }
  return stableHash(value);
}

function assertWebsiteAuthenticationIdempotencyKey(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new RepositoryError("INVALID_STATE");
  }
}

function normalizeWebsiteAuthenticationReference(value: string): string {
  if (typeof value !== "string" || !/^urn:sha256:[0-9a-f]{64}$/.test(value)) {
    throw new RepositoryError("INVALID_STATE");
  }
  return value;
}

function normalizeWebsiteAuthenticationDigest(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RepositoryError("INVALID_STATE");
  }
  return value;
}

function normalizeWebsiteAuthenticationWaitInput(
  input: WaitAnalysisForAuthenticationInput,
  now: Date,
): WaitAnalysisForAuthenticationInput {
  assertWebsiteAuthenticationIdempotencyKey(input.idempotencyKey);
  stableHashBounded(input.inputHash);
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime() || expiry - now.getTime() > 10 * 60_000) {
    throw new RepositoryError("INVALID_STATE");
  }
  return {
    ...input,
    checkpointReference: normalizeWebsiteAuthenticationReference(input.checkpointReference),
    sourceIdentityHash: normalizeWebsiteAuthenticationDigest(input.sourceIdentityHash),
    targetOriginDigest: normalizeWebsiteAuthenticationDigest(input.targetOriginDigest),
    expiresAt: new Date(expiry).toISOString(),
  };
}

function normalizeWebsiteAuthenticationResumeInput(
  input: ResumeAnalysisAfterAuthenticationInput,
): ResumeAnalysisAfterAuthenticationInput {
  assertWebsiteAuthenticationIdempotencyKey(input.idempotencyKey);
  stableHashBounded(input.inputHash);
  return {
    ...input,
    checkpointReference: normalizeWebsiteAuthenticationReference(input.checkpointReference),
    authenticationEvidenceReference: normalizeWebsiteAuthenticationReference(input.authenticationEvidenceReference),
    sourceIdentityHash: normalizeWebsiteAuthenticationDigest(input.sourceIdentityHash),
    targetOriginDigest: normalizeWebsiteAuthenticationDigest(input.targetOriginDigest),
  };
}

function websiteTargetOriginDigest(sourceUrl: string): string {
  let origin: string;
  try {
    origin = new URL(sourceUrl).origin;
  } catch {
    throw new RepositoryError("INVALID_STATE");
  }
  return createHash("sha256").update(origin, "utf8").digest("hex");
}

function websiteAuthenticationWaitMatches(
  checkpoint: WebsiteAuthenticationCheckpointRecord,
  input: WaitAnalysisForAuthenticationInput,
): boolean {
  return checkpoint.checkpointReference === input.checkpointReference
    && checkpoint.sourceSnapshotId === input.sourceSnapshotId
    && checkpoint.sourceIdentityHash === input.sourceIdentityHash
    && checkpoint.targetOriginDigest === input.targetOriginDigest
    && checkpoint.expiresAt === input.expiresAt;
}

function websiteAuthenticationResumeMatches(
  checkpoint: WebsiteAuthenticationCheckpointRecord,
  input: ResumeAnalysisAfterAuthenticationInput,
): boolean {
  return checkpoint.analysisRunId === input.runId
    && checkpoint.checkpointReference === input.checkpointReference
    && checkpoint.sourceSnapshotId === input.sourceSnapshotId
    && checkpoint.sourceIdentityHash === input.sourceIdentityHash
    && checkpoint.targetOriginDigest === input.targetOriginDigest
    && (checkpoint.authenticationEvidenceReference === undefined
      || checkpoint.authenticationEvidenceReference === input.authenticationEvidenceReference);
}

function workflowTaskEventPayload(input: WorkflowTaskEventInput): WorkflowTaskEventInput["payload"] {
  const payload = input?.payload;
  const allowed = input?.type === "task.side_effect_started"
    ? ["inputHash", "operation"]
    : input?.type === "task.side_effect_completed"
      ? ["costMicros", "durationMs", "inputHash", "operation", "outputHash", "version"]
      : input?.type === "task.side_effect_failed"
        ? ["durationMs", "inputHash", "operation", "outcome"]
        : [];
  if (!payload || typeof payload !== "object" || allowed.length === 0
    || Object.keys(payload).some((key) => !allowed.includes(key))
    || typeof payload.operation !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/.test(payload.operation)
    || typeof payload.inputHash !== "string" || !/^[0-9a-f]{64}$/.test(payload.inputHash)
    || input.type !== "task.side_effect_started" && (!Number.isSafeInteger(payload.durationMs)
      || payload.durationMs! < 0 || payload.durationMs! > 3_600_000)
    || input.type === "task.side_effect_completed" && (typeof payload.outputHash !== "string"
      || !/^[0-9a-f]{64}$/.test(payload.outputHash))
    || payload.version !== undefined && (typeof payload.version !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(payload.version))
    || payload.costMicros !== undefined && (!Number.isSafeInteger(payload.costMicros)
      || payload.costMicros < 0 || payload.costMicros > 1_000_000_000)
    || input.type === "task.side_effect_failed" && payload.outcome !== "failure") {
    throw new RepositoryError("INVALID_STATE");
  }
  return payload;
}

function workflowTaskIdempotencyKey(runId: string, phase: WorkflowTaskRecord["phase"], inputHash: string): string {
  const normalizedHash = stableHash(inputHash);
  return `wft_${stableHash(`${runId.length}:${runId}:${phase.length}:${phase}:${normalizedHash}`)}`;
}

function assertWorkflowWorkerId(workerId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId)) throw new RepositoryError("INVALID_STATE");
}

function assertWorkflowCommand(scope: string, key: string): void {
  if (!/^[a-z][a-z0-9_:-]{0,127}$/.test(scope)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(key)) throw new RepositoryError("INVALID_STATE");
}

function validateWorkflowReference(reference: string | undefined): void {
  if (reference !== undefined && !/^urn:sha256:[0-9a-f]{64}$/.test(reference)) {
    throw new RepositoryError("INVALID_STATE");
  }
}

function validateWorkflowErrorCode(code: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw new RepositoryError("INVALID_STATE");
}

function normalizeWorkflowErrorCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "ANALYSIS_FAILED";
}

function validateWorkflowWait(reason: string, expiresAt: string): void {
  const expiry = Date.parse(expiresAt);
  const now = Date.now();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(reason) || !Number.isFinite(expiry)
    || expiry <= now || expiry - now > 24 * 60 * 60 * 1_000) throw new RepositoryError("INVALID_STATE");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapPostgresError(error: unknown): unknown {
  if (error instanceof RepositoryError) return error;
  if (!(error instanceof pg.DatabaseError)) return error;
  if (error.code === "42501" && /active auth session required/i.test(error.message)) {
    return new RepositoryError("SESSION_REVOKED");
  }
  if (error.code === "42501") return new RepositoryError("FORBIDDEN");
  if (error.code === "23505") {
    if (error.constraint === "analysis_runs_one_active_per_project_idx") return new RepositoryError("INVALID_STATE");
    if (error.constraint === "workflow_runs_one_active_per_project_idx") return new RepositoryError("INVALID_STATE");
    if (error.constraint === "capabilities_run_name_key") return new RepositoryError("INVALID_STATE");
    return new RepositoryError("VERSION_CONFLICT");
  }
  if (error.code === "23503" || error.code === "23514" || error.code === "22P02") return new RepositoryError("INVALID_STATE");
  return error;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
