# Task 9 recovery runbook

Run all commands from the immutable release checkout. Start with `pnpm release:readiness`, retain its JSON result, correlate the incident by workflow ID and monotonically ordered event sequence, and never edit workflow tables or immutable evidence/artifacts by hand.

| Incident | Fail-closed check | Recovery |
| --- | --- | --- |
| Provider outage | Confirm a retryable classified task failure and no completed side effect. | Keep the original idempotency/input hash; allow bounded backoff or cancel. |
| Stuck workflow | Confirm lease expiry and no active owner. | Run the reconciler; verify exactly one claim/next task. |
| Leaked browser session | Confirm terminal/cancel event and cleanup/reconcile attempt. | Revoke the provider session, then reconcile; never resume the leaked session. |
| Bad model/parser/compiler | Confirm the candidate failed canonical validation or deterministic replay. | Pin/roll back the component, reanalyse from immutable evidence, and repeat golden gates. |
| Compromised artifact | Compare served/executed SHA-256 and SRI to the immutable release. | Block delivery, preserve evidence, and point users to a previously verified immutable release; never replace bytes at an existing URL. |
| GitHub revocation | Confirm token revocation and terminal workflow. | Re-authorize the repository-scoped App and start a new reviewed workflow; never merge/install automatically. |
| Rollback | Confirm the previous release bytes and verification remain immutable. | Change only the installation pointer/script tag, then run installed-target verification. |
| Database restore | Confirm migrations, RLS/grants, workflow sequences, evidence hashes, and artifact integrity. | Restore to an isolated database, run PG/RLS and readiness gates, then switch traffic only after validation. |

Before closing an incident, run `pnpm test:golden`, `pnpm release:readiness`, the environment-gated PostgreSQL suite, and the appropriate browser/provider checks. An unavailable live environment is a recorded skip, never a successful live check.
