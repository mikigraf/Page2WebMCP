import assert from "node:assert/strict";
import test from "node:test";
import { deriveOperationalMetrics, evaluateOperationalAlerts } from "./metrics.ts";

const now = new Date("2026-08-30T12:10:00.000Z");

test("operational metrics cover workflow, provider, verification, conversion, database, reconciliation, retention, and telemetry", () => {
  const metrics = deriveOperationalMetrics({
    now,
    runs: [
      { status: "queued", createdAt: "2026-08-30T12:00:00.000Z" },
      { status: "running", createdAt: "2026-08-30T12:09:00.000Z" },
      { status: "failed", createdAt: "2026-08-30T12:08:00.000Z" },
    ],
    tasks: [
      { status: "queued", attempts: 2, availableAt: "2026-08-30T12:01:00.000Z" },
      { status: "running", attempts: 1, availableAt: "2026-08-30T12:02:00.000Z", leaseExpiresAt: "2026-08-30T12:11:00.000Z" },
      { status: "running", attempts: 3, availableAt: "2026-08-30T12:03:00.000Z", leaseExpiresAt: "2026-08-30T12:09:00.000Z" },
    ],
    counters: {
      providerErrors: 7,
      browserErrors: 3,
      modelErrors: 2,
      verificationAttempts: 10,
      verificationFailures: 4,
      releasesPublished: 8,
      installationsVerified: 3,
      reconciliations: 5,
      reconciliationFailures: 1,
      retentionFailures: 2,
      telemetryDropped: 11,
    },
    databasePool: { active: 8, idle: 1, waiting: 2, max: 10 },
  });

  assert.deepEqual(metrics, {
    workflow_queue_depth: 1,
    workflow_oldest_queue_age_seconds: 540,
    workflow_active_leases: 1,
    workflow_expired_leases: 1,
    workflow_retries: 3,
    provider_errors: 7,
    browser_errors: 3,
    model_errors: 2,
    verification_attempts: 10,
    verification_failures: 4,
    publish_install_conversion_ratio: 0.375,
    db_pool_active: 8,
    db_pool_idle: 1,
    db_pool_waiting: 2,
    db_pool_utilization_ratio: 0.8,
    reconciliations: 5,
    reconciliation_failures: 1,
    retention_failures: 2,
    telemetry_dropped: 11,
  });
});

test("operational alerts are deterministic, bounded, and actionable", () => {
  const alerts = evaluateOperationalAlerts({
    workflow_queue_depth: 121,
    workflow_oldest_queue_age_seconds: 901,
    workflow_active_leases: 4,
    workflow_expired_leases: 1,
    workflow_retries: 21,
    provider_errors: 7,
    browser_errors: 0,
    model_errors: 0,
    verification_attempts: 10,
    verification_failures: 4,
    publish_install_conversion_ratio: 0.2,
    db_pool_active: 9,
    db_pool_idle: 0,
    db_pool_waiting: 3,
    db_pool_utilization_ratio: 0.95,
    reconciliations: 0,
    reconciliation_failures: 1,
    retention_failures: 1,
    telemetry_dropped: 8,
  });

  assert.deepEqual(alerts.map(({ code, severity }) => [code, severity]), [
    ["DB_POOL_SATURATED", "critical"],
    ["LEASE_EXPIRED", "critical"],
    ["QUEUE_AGE_HIGH", "critical"],
    ["RECONCILIATION_FAILED", "critical"],
    ["RETENTION_FAILED", "critical"],
    ["QUEUE_DEPTH_HIGH", "warning"],
    ["PROVIDER_ERRORS_HIGH", "warning"],
    ["PUBLISH_INSTALL_CONVERSION_LOW", "warning"],
    ["TELEMETRY_DROPPED", "warning"],
    ["VERIFICATION_FAILURE_RATE_HIGH", "warning"],
  ]);
  assert.equal(alerts.every(({ value }) => Number.isFinite(value) && value >= 0), true);
});
