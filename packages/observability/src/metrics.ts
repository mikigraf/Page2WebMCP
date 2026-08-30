export type OperationalMetrics = Readonly<{
  workflow_queue_depth: number;
  workflow_oldest_queue_age_seconds: number;
  workflow_active_leases: number;
  workflow_expired_leases: number;
  workflow_retries: number;
  provider_errors: number;
  browser_errors: number;
  model_errors: number;
  verification_attempts: number;
  verification_failures: number;
  publish_install_conversion_ratio: number;
  db_pool_active: number;
  db_pool_idle: number;
  db_pool_waiting: number;
  db_pool_utilization_ratio: number;
  reconciliations: number;
  reconciliation_failures: number;
  retention_failures: number;
  telemetry_dropped: number;
}>;

type OperationalMetricInput = Readonly<{
  now: Date;
  runs: readonly Readonly<{ status: string; createdAt: string }>[];
  tasks: readonly Readonly<{
    status: string;
    attempts: number;
    availableAt: string;
    leaseExpiresAt?: string;
  }>[];
  counters: Readonly<{
    providerErrors: number;
    browserErrors: number;
    modelErrors: number;
    verificationAttempts: number;
    verificationFailures: number;
    releasesPublished: number;
    installationsVerified: number;
    reconciliations: number;
    reconciliationFailures: number;
    retentionFailures: number;
    telemetryDropped: number;
  }>;
  databasePool: Readonly<{ active: number; idle: number; waiting: number; max: number }>;
}>;

export type OperationalAlert = Readonly<{
  code: string;
  severity: "warning" | "critical";
  value: number;
}>;

export function deriveOperationalMetrics(input: OperationalMetricInput): OperationalMetrics {
  const now = Number.isFinite(input.now.getTime()) ? input.now.getTime() : Date.now();
  const queued = input.tasks.filter(({ status }) => status === "queued");
  const queueAges = queued.map(({ availableAt }) => Math.max(0, now - safeDate(availableAt, now)) / 1_000);
  const running = input.tasks.filter(({ status }) => status === "running");
  const active = running.filter(({ leaseExpiresAt }) => safeDate(leaseExpiresAt, 0) > now).length;
  const expired = running.length - active;
  const published = count(input.counters.releasesPublished);
  const installed = Math.min(published, count(input.counters.installationsVerified));
  const poolMax = Math.max(1, count(input.databasePool.max));
  return {
    workflow_queue_depth: queued.length,
    workflow_oldest_queue_age_seconds: Math.round(Math.max(0, ...queueAges)),
    workflow_active_leases: active,
    workflow_expired_leases: expired,
    workflow_retries: input.tasks.reduce((total, task) => total + Math.max(0, count(task.attempts) - 1), 0),
    provider_errors: count(input.counters.providerErrors),
    browser_errors: count(input.counters.browserErrors),
    model_errors: count(input.counters.modelErrors),
    verification_attempts: count(input.counters.verificationAttempts),
    verification_failures: count(input.counters.verificationFailures),
    publish_install_conversion_ratio: published === 0 ? 0 : installed / published,
    db_pool_active: count(input.databasePool.active),
    db_pool_idle: count(input.databasePool.idle),
    db_pool_waiting: count(input.databasePool.waiting),
    db_pool_utilization_ratio: Math.min(1, count(input.databasePool.active) / poolMax),
    reconciliations: count(input.counters.reconciliations),
    reconciliation_failures: count(input.counters.reconciliationFailures),
    retention_failures: count(input.counters.retentionFailures),
    telemetry_dropped: count(input.counters.telemetryDropped),
  };
}

export function evaluateOperationalAlerts(metrics: OperationalMetrics): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  add(alerts, metrics.db_pool_utilization_ratio >= 0.9 || metrics.db_pool_waiting > 0,
    "DB_POOL_SATURATED", "critical", Math.max(metrics.db_pool_utilization_ratio, metrics.db_pool_waiting));
  add(alerts, metrics.workflow_expired_leases > 0, "LEASE_EXPIRED", "critical", metrics.workflow_expired_leases);
  add(alerts, metrics.workflow_oldest_queue_age_seconds >= 900,
    "QUEUE_AGE_HIGH", "critical", metrics.workflow_oldest_queue_age_seconds);
  add(alerts, metrics.reconciliation_failures > 0,
    "RECONCILIATION_FAILED", "critical", metrics.reconciliation_failures);
  add(alerts, metrics.retention_failures > 0, "RETENTION_FAILED", "critical", metrics.retention_failures);
  add(alerts, metrics.workflow_queue_depth >= 100, "QUEUE_DEPTH_HIGH", "warning", metrics.workflow_queue_depth);
  add(alerts, metrics.provider_errors + metrics.browser_errors + metrics.model_errors >= 5,
    "PROVIDER_ERRORS_HIGH", "warning", metrics.provider_errors + metrics.browser_errors + metrics.model_errors);
  add(alerts, metrics.publish_install_conversion_ratio < 0.25,
    "PUBLISH_INSTALL_CONVERSION_LOW", "warning", metrics.publish_install_conversion_ratio);
  add(alerts, metrics.telemetry_dropped > 0, "TELEMETRY_DROPPED", "warning", metrics.telemetry_dropped);
  const verificationRate = metrics.verification_attempts === 0
    ? 0
    : metrics.verification_failures / metrics.verification_attempts;
  add(alerts, metrics.verification_attempts >= 5 && verificationRate >= 0.25,
    "VERIFICATION_FAILURE_RATE_HIGH", "warning", verificationRate);
  return alerts;
}

function add(
  alerts: OperationalAlert[],
  condition: boolean,
  code: string,
  severity: OperationalAlert["severity"],
  value: number,
): void {
  if (condition && Number.isFinite(value) && value >= 0) alerts.push({ code, severity, value });
}

function count(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0;
}

function safeDate(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
