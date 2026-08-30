import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import {
  canonicalizeCapabilityPlans,
  type CapabilityPlan,
} from "../../capability-ir/src/plan.ts";
import {
  capabilityPlanDigest,
  capabilityStateDigest,
  normalizeAnalysisDiagnostics,
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
  type IdempotentRequest,
  type ProjectRecord,
  type PublishRequest,
  type ReleaseRecord,
  type RepositoryActor,
  type ReviewInput,
  type SourceType,
  type VerificationRecord,
  type VerificationRequest
} from "./control-plane.ts";

type PostgresOptions = {
  connectionString: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  pool?: pg.Pool;
  writeLog?: (line: string) => void;
};
type Db = Pick<PoolClient, "query">;
type ExecutionContext =
  | { kind: "app"; actor: RepositoryActor }
  | { kind: "artifact" }
  | { kind: "worker" };

const MAX_PROJECTS = 500;
const MAX_CAPABILITIES = 1_000;
const MAX_EVIDENCE = 1_000;
const MAX_AUDIT_EVENTS = 1_000;
const MAX_RELEASE_BYTES = 64 * 1_024;

export class PostgresControlPlaneRepository implements ControlPlaneRepository {
  readonly #pool: pg.Pool;
  readonly #statementTimeoutMs: number;

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
    operation: "project" | "analysis" | "release",
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
      await this.#audit(client, actor, "project.created", id);
      return mapProject(result.rows[0]);
    });
  }

  async listProjects(actor: RepositoryActor): Promise<ProjectRecord[]> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const result = await client.query(
        "select id, organization_id, created_by, name, source_type, source_url, status, created_at " +
        "from public.projects where organization_id = $1 order by created_at, id limit $2",
        [actor.organizationId, MAX_PROJECTS]
      );
      return result.rows.map(mapProject);
    });
  }

  async getProject(actor: RepositoryActor, id: string): Promise<ProjectRecord> {
    return this.#transaction({ kind: "app", actor }, (client) => this.#project(client, actor, id));
  }

  async enqueueAnalysis(actor: RepositoryActor, input: IdempotentRequest): Promise<AnalysisRunRecord> {
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
        "insert into public.analysis_runs " +
        "(id, organization_id, project_id, requested_by, status, attempts) " +
        "values ($1, $2, $3, $4, 'queued', 0) " +
        "returning id, organization_id, project_id, requested_by, status, attempts, error_code, created_at, updated_at",
        [runId, actor.organizationId, project.id, actor.id]
      );
      await client.query(
        "insert into private.analysis_jobs (analysis_run_id, organization_id, source_type, source_url) " +
        "values ($1, $2, $3, $4)",
        [runId, actor.organizationId, project.sourceType, project.url]
      );
      await this.#audit(client, actor, "analysis.queued", runId);
      return mapAnalysis(result.rows[0]);
    });
  }

  async #analysis(db: Db, actor: RepositoryActor, id: string): Promise<AnalysisRunRecord> {
    const result = await db.query(
      "select ar.id, ar.organization_id, ar.project_id, ar.requested_by, ar.status, " +
      "ar.attempts, ar.error_code, ar.created_at, ar.updated_at, j.lease_owner, j.lease_expires_at " +
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

  async #workerAnalysis(db: Db, id: string): Promise<AnalysisRunRecord> {
    const result = await db.query(
      "select ar.id, ar.organization_id, ar.project_id, ar.requested_by, ar.status, ar.attempts, " +
      "ar.error_code, ar.created_at, ar.updated_at, j.lease_owner, j.lease_expires_at " +
      "from public.analysis_runs ar join private.analysis_jobs j " +
      "on j.analysis_run_id = ar.id and j.organization_id = ar.organization_id " +
      "where ar.id = $1 limit 1",
      [id]
    );
    if (!result.rows[0]) throw new RepositoryError("INVALID_STATE");
    return mapAnalysis(result.rows[0]);
  }

  async claimAnalysis(workerId: string, leaseMs: number): Promise<ClaimedAnalysisRunRecord | undefined> {
    return this.#transaction({ kind: "worker" }, async (client) => {
      const exhausted = await client.query(
        "select analysis_run_id from private.analysis_jobs where status = 'running' " +
        "and lease_expires_at <= now() and attempts >= 3 order by lease_expires_at, analysis_run_id " +
        "for update skip locked limit 100"
      );
      if (exhausted.rowCount) {
        const exhaustedIds = exhausted.rows.map((row) => row.analysis_run_id);
        await client.query(
          "update public.analysis_runs set error_code = 'ATTEMPTS_EXHAUSTED', updated_at = now() " +
          "where id = any($1::uuid[]) and status = 'running'",
          [exhaustedIds]
        );
        await client.query(
          "update private.analysis_jobs set status = 'failed', lease_owner = null, lease_expires_at = null, " +
          "updated_at = now() where analysis_run_id = any($1::uuid[]) and status = 'running'",
          [exhaustedIds]
        );
      }
      const candidate = await client.query(
        "select analysis_run_id from private.analysis_jobs " +
        "where ((status = 'queued' and available_at <= now()) or " +
        "(status = 'running' and lease_expires_at <= now())) and attempts < 3 " +
        "order by available_at, created_at, analysis_run_id for update skip locked limit 1"
      );
      const runId = candidate.rows[0]?.analysis_run_id;
      if (!runId) return undefined;
      const boundedLease = Math.max(1_000, Math.min(leaseMs, 300_000));
      const job = await client.query(
        "update private.analysis_jobs set status = 'running', attempts = attempts + 1, lease_owner = $2, " +
        "lease_expires_at = now() + ($3::integer * interval '1 millisecond'), updated_at = now() " +
        "where analysis_run_id = $1 returning lease_owner, lease_expires_at, source_type, source_url",
        [runId, workerId, boundedLease]
      );
      const result = await client.query(
        "select ar.id, ar.organization_id, ar.project_id, ar.requested_by, ar.status, ar.attempts, " +
        "ar.error_code, ar.created_at, ar.updated_at, $2::text as lease_owner, $3::timestamptz as lease_expires_at, " +
        "$4::text as source_type, $5::text as source_url " +
        "from public.analysis_runs ar where ar.id = $1 limit 1",
        [runId, job.rows[0].lease_owner, job.rows[0].lease_expires_at, job.rows[0].source_type, job.rows[0].source_url]
      );
      if (!result.rows[0]) throw new RepositoryError("INVALID_STATE");
      return mapClaimedAnalysis(result.rows[0]);
    });
  }

  async heartbeatAnalysis(workerId: string, runId: string, leaseMs: number): Promise<void> {
    const boundedLease = Math.max(1_000, Math.min(leaseMs, 300_000));
    await this.#transaction({ kind: "worker" }, async (client) => {
      const result = await client.query(
        "update private.analysis_jobs set lease_expires_at = now() + ($3::integer * interval '1 millisecond'), " +
        "updated_at = now() where analysis_run_id = $1 and status = 'running' and lease_owner = $2 " +
        "and lease_expires_at > now() returning analysis_run_id",
        [runId, workerId, boundedLease]
      );
      if (!result.rows[0]) throw new RepositoryError("LEASE_LOST");
    });
  }

  async completeAnalysis(workerId: string, runId: string, result: AnalysisResult): Promise<AnalysisRunRecord> {
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
      const job = await client.query(
        "select j.organization_id, ar.project_id from private.analysis_jobs j " +
        "join public.analysis_runs ar on ar.id = j.analysis_run_id and ar.organization_id = j.organization_id " +
        "where j.analysis_run_id = $1 and j.status = 'running' and j.lease_owner = $2 " +
        "and j.lease_expires_at > now() for update of j",
        [runId, workerId]
      );
      if (!job.rows[0]) throw new RepositoryError("LEASE_LOST");
      const organizationId = String(job.rows[0].organization_id);
      const projectId = String(job.rows[0].project_id);
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
      for (const evidence of normalizedEvidence) {
        await client.query(
          "insert into public.analysis_evidence " +
          "(organization_id, project_id, analysis_run_id, source, payload, content, reference, expires_at) " +
          "values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::timestamptz)",
          [organizationId, projectId, runId, evidence.source, JSON.stringify(evidence),
            evidence.content, evidence.reference, evidence.expiresAt]
        );
      }
      for (const plan of canonicalPlans) {
        const status = statuses.get(plan.tool.name) ?? "proposed";
        const planDigest = capabilityPlanDigest(plan);
        await client.query(
          "insert into public.capabilities " +
          "(organization_id, project_id, analysis_run_id, stable_name, risk_tier, status, plan, plan_digest, " +
          "reviewed_plan_digest, version) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 1)",
          [organizationId, projectId, runId, plan.tool.name, plan.effects.riskTier, status,
            JSON.stringify(plan), planDigest, plan.effects.riskTier === "R0" || status === "blocked" ? planDigest : null]
        );
      }
      const releaseHash = result.release === undefined
        ? null
        : createHash("sha256").update(Buffer.from(result.release.code)).digest("hex");
      await client.query(
        "update public.analysis_runs set result = $2::jsonb, release_code = $3, release_hash = $4, " +
        "allowed_origin = $5, release_manifest = $6::jsonb, error_code = null, updated_at = now() where id = $1",
        [runId, JSON.stringify({ diagnostics: normalizedDiagnostics, draftPullRequest: result.draftPullRequest }),
          result.release?.code ?? null, releaseHash, result.release?.allowedOrigin ?? null,
          result.release === undefined ? null : JSON.stringify(result.release.manifest ?? {})]
      );
      const completed = await client.query(
        "update private.analysis_jobs set status = 'succeeded', lease_owner = null, lease_expires_at = null, " +
        "updated_at = now() where analysis_run_id = $1 and lease_owner = $2 and lease_expires_at > now() " +
        "returning analysis_run_id",
        [runId, workerId]
      );
      if (!completed.rows[0]) throw new RepositoryError("LEASE_LOST");
      return this.#workerAnalysis(client, runId);
    });
  }

  async failAnalysis(workerId: string, runId: string, code: string, retryable: boolean): Promise<AnalysisRunRecord> {
    return this.#transaction({ kind: "worker" }, async (client) => {
      const job = await client.query(
        "select attempts from private.analysis_jobs where analysis_run_id = $1 and status = 'running' " +
        "and lease_owner = $2 and lease_expires_at > now() for update",
        [runId, workerId]
      );
      if (!job.rows[0]) throw new RepositoryError("LEASE_LOST");
      const terminal = !retryable || Number(job.rows[0].attempts) >= 3;
      await client.query("update public.analysis_runs set error_code = $2, updated_at = now() where id = $1", [runId, code.slice(0, 128)]);
      await client.query(
        "update private.analysis_jobs set status = $2, " +
        "available_at = case when $2 = 'queued' then now() + interval '1 second' else available_at end, " +
        "lease_owner = null, lease_expires_at = null, updated_at = now() where analysis_run_id = $1",
        [runId, terminal ? "failed" : "queued"]
      );
      return this.#workerAnalysis(client, runId);
    });
  }

  async getAnalysisResult(actor: RepositoryActor, runId: string): Promise<AnalysisResult | undefined> {
    return this.#transaction({ kind: "app", actor }, async (client) => {
      const run = await client.query(
        "select result, release_code, release_hash, allowed_origin, release_manifest from public.analysis_runs " +
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
        draftPullRequest: stored?.draftPullRequest
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
      if (input.action === "approve" && capability.riskTier !== "R0" && actor.role !== "owner") {
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
        "r.content_hash, r.sri, r.code, r.allowed_origin, r.manifest, r.status, r.created_at " +
        "from public.releases r " +
        "where r.project_id = $1 and r.analysis_run_id = $2 limit 1",
        [projectId, run.id]
      );
      if (published.rows[0]) {
        const verification = await client.query(
          "select id, project_id, analysis_run_id, capability_state_digest, candidate_content_hash, schema_valid, " +
          "candidate_code, candidate_allowed_origin, candidate_manifest, authenticated, replay_passes, " +
          "no_secret_leakage, browser_execution, selection_score, eligible, failures, created_at " +
          "from public.verification_runs where project_id = $1 and organization_id = $2 and analysis_run_id = $3 " +
          "and capability_state_digest = $4 and candidate_content_hash = $5 order by revision desc limit 1",
          [projectId, actor.organizationId, run.id, input.capabilityStateDigest, candidateContentHash]
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
      const failures = verificationFailures(input);
      const result = await client.query(
        "insert into public.verification_runs " +
        "(organization_id, project_id, analysis_run_id, capability_state_digest, candidate_content_hash, " +
        "candidate_code, candidate_allowed_origin, candidate_manifest, schema_valid, authenticated, replay_passes, " +
        "no_secret_leakage, browser_execution, selection_score, eligible, failures) " +
        "values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16) " +
        "returning id, project_id, analysis_run_id, capability_state_digest, candidate_content_hash, schema_valid, authenticated, " +
        "replay_passes, no_secret_leakage, browser_execution, selection_score, eligible, failures, created_at",
        [actor.organizationId, projectId, input.analysisRunId, input.capabilityStateDigest, candidateContentHash,
          input.candidate.code, input.candidate.allowedOrigin, JSON.stringify(input.candidate.manifest ?? {}),
          input.schema, input.authenticated, input.replayPasses, input.noSecretLeakage, input.browserExecution,
          input.selectionScore, failures.length === 0, failures]
      );
      return mapVerification(result.rows[0]);
    });
  }

  async publishRelease(actor: RepositoryActor, input: PublishRequest): Promise<ReleaseRecord> {
    if (actor.role !== "owner") throw new RepositoryError("FORBIDDEN");
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
        "select eligible, failures, candidate_content_hash, candidate_code, candidate_allowed_origin, candidate_manifest " +
        "from public.verification_runs where project_id = $1 and organization_id = $2 " +
        "and analysis_run_id = $3 and capability_state_digest = $4 order by revision desc limit 1",
        [input.projectId, actor.organizationId, input.analysisRunId, input.capabilityStateDigest]
      );
      if (!verification.rows[0]?.eligible) {
        throw new RepositoryError("RELEASE_GATE_FAILED", verification.rows[0]?.failures ?? ["VERIFICATION_MISSING"]);
      }
      if (String(verification.rows[0].candidate_content_hash) !== input.candidateContentHash) {
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
        "manifest, status, created_at from public.releases where project_id = $1 and analysis_run_id = $2 limit 1",
        [input.projectId, input.analysisRunId]
      );
      if (existing.rows[0]) {
        if (String(existing.rows[0].content_hash) !== input.candidateContentHash) {
          throw new RepositoryError("RELEASE_GATE_FAILED", ["CANDIDATE_CHANGED"]);
        }
        await client.query(
          "update private.idempotency_keys set result_id = $5 where organization_id = $1 and actor_id = $2 " +
          "and operation = 'release' and idempotency_key = $3 and input_hash = $4",
          [actor.organizationId, actor.id, input.idempotencyKey, input.inputHash, existing.rows[0].id]
        );
        return mapRelease(existing.rows[0]);
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
        "(id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, allowed_origin, manifest, status) " +
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'published') returning id, organization_id, project_id, " +
        "analysis_run_id, capability_state_digest, content_hash, sri, code, allowed_origin, manifest, status, created_at",
        [proposedId, actor.organizationId, input.projectId, input.analysisRunId, input.capabilityStateDigest,
          contentHash, sri, code, verifiedCandidate.allowedOrigin,
          JSON.stringify(verifiedCandidate.manifest ?? {})]
      );
      await this.#audit(client, actor, "release.published", proposedId);
      return mapRelease(release.rows[0]);
    });
  }

  async #releaseById(db: Db, actor: RepositoryActor, input: PublishRequest, id: string): Promise<ReleaseRecord> {
    const result = await db.query(
      "select id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, allowed_origin, " +
      "manifest, status, created_at from public.releases where id = $1 and organization_id = $2 " +
      "and project_id = $3 and analysis_run_id = $4 limit 1",
      [id, actor.organizationId, input.projectId, input.analysisRunId]
    );
    if (!result.rows[0] || String(result.rows[0].content_hash) !== input.candidateContentHash) {
      throw new RepositoryError("INVALID_STATE");
    }
    return mapRelease(result.rows[0]);
  }

  async getReleaseArtifact(contentHash: string): Promise<ReleaseRecord> {
    return this.#transaction({ kind: "artifact" }, async (client) => {
      const result = await client.query(
        "select id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, sri, code, allowed_origin, " +
        "manifest, status, created_at from public.releases where content_hash = $1 and status = 'published' " +
        "order by created_at, id limit 1",
        [contentHash]
      );
      if (!result.rows[0]) throw new RepositoryError("NOT_FOUND");
      return mapRelease(result.rows[0]);
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
      "truncate public.audit_events, public.releases, public.verification_runs, public.capability_reviews, " +
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

function mapAnalysis(row: QueryResultRow): AnalysisRunRecord {
  return { id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    requestedBy: String(row.requested_by), status: row.status as AnalysisRunRecord["status"], attempts: Number(row.attempts),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : undefined,
    errorCode: row.error_code ? String(row.error_code) : undefined, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapClaimedAnalysis(row: QueryResultRow): ClaimedAnalysisRunRecord {
  return {
    ...mapAnalysis(row),
    sourceType: row.source_type as SourceType,
    sourceUrl: String(row.source_url)
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
  return { id: String(row.id), projectId: String(row.project_id), analysisRunId: String(row.analysis_run_id),
    capabilityStateDigest: String(row.capability_state_digest), schema: Boolean(row.schema_valid),
    candidateContentHash: String(row.candidate_content_hash),
    authenticated: Boolean(row.authenticated), replayPasses: Number(row.replay_passes),
    noSecretLeakage: Boolean(row.no_secret_leakage), browserExecution: Boolean(row.browser_execution),
    selectionScore: Number(row.selection_score), eligible: Boolean(row.eligible), failures: row.failures as string[],
    createdAt: iso(row.created_at) };
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
  return { id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    analysisRunId: String(row.analysis_run_id), capabilityStateDigest: String(row.capability_state_digest),
    contentHash: String(row.content_hash), sri: String(row.sri),
    code: String(row.code), allowedOrigin: String(row.allowed_origin), manifest: row.manifest,
    status: "published", createdAt: iso(row.created_at) };
}

function verificationFailures(
  input: VerificationRequest
): string[] {
  return [!input.schema && "SCHEMA", !input.authenticated && "AUTH", input.replayPasses < 3 && "REPLAY",
    !input.noSecretLeakage && "SECRET_LEAKAGE", !input.browserExecution && "BROWSER",
    input.selectionScore < 18 && "TOOL_SELECTION"].filter(Boolean) as string[];
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapPostgresError(error: unknown): unknown {
  if (error instanceof RepositoryError) return error;
  if (!(error instanceof pg.DatabaseError)) return error;
  if (error.code === "42501") return new RepositoryError("FORBIDDEN");
  if (error.code === "23505") {
    if (error.constraint === "analysis_runs_one_active_per_project_idx") return new RepositoryError("INVALID_STATE");
    if (error.constraint === "capabilities_run_name_key") return new RepositoryError("INVALID_STATE");
    return new RepositoryError("VERSION_CONFLICT");
  }
  if (error.code === "23503" || error.code === "23514" || error.code === "22P02") return new RepositoryError("INVALID_STATE");
  return error;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
