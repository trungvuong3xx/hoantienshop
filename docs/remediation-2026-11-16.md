# Remediation and verification — 2026-11-16

## Implemented
- Removed known authentication/admin/postback secret fallbacks. Production requires a signing secret of at least 32 characters, PostgreSQL, and ADMIN_PASSWORD. Development without a secret uses an ephemeral random signing key; without ADMIN_PASSWORD the generated admin password is deliberately unknown. Existing password hashes are not overwritten.
- PostgreSQL certificate verification defaults to enabled. Configure a trusted CA when needed.
- Rate limits use Express req.ip and its trust-proxy boundary. Direct deployments no longer trust loopback forwarding headers by default. Production auth/withdrawal routes require distributed rate limiting; malformed Redis responses are rejected.
- Tests no longer load .env or the application's seed database; normal regression tests cannot inherit a PostgreSQL connection through the runner.
- Snapshot writes lock/check the shared version before changing relational rows. Conflicts return STATE_CONFLICT/409 instead of reloading and falsely reporting the original operation as saved.
- Direct withdrawals increment the shared version in their transaction and do not subsequently write a stale full snapshot. Idempotency is checked under the user row lock and protected by a partial unique index; conflicting replay payloads are rejected.
- PostgreSQL is the write authority when configured; routine saves no longer write local JSON before the database transaction.
- Retain all clicks within the existing 30-day policy rather than silently dropping valid attribution at 500/5000/20000 records. PostgreSQL reload uses the same time window.
- Auth middleware checks token version, role, account lock and soft-delete status against PostgreSQL, rather than relying only on instance cache.
- PostgreSQL initialization is transactional and serialized; initialization no longer overwrites the snapshot without a version change. Reload reads use a repeatable-read transaction.

## Verification
- npm test: 21 suites passed, including new security/idempotency regressions.
- npm run test:postgres with PG_TEST_URL pointing to a disposable localhost PostgreSQL 18.7 instance: six integration scenarios passed using independent Node processes.
- Integration scenarios: stale save conflict; same-key concurrent withdrawal; preservation of newly committed withdrawal; rejected stale refund after paid; 6001 clicks saved/reloaded; revoked token rejected with stale cache.
- Fixed a Windows libuv shutdown crash in test_audit_round2 by allowing natural process termination.
- Product-provider integration requiring a real Shopee response is not covered by these offline regressions.

## Before deployment
1. Configure the required values in .env.example in the deployment secret store. Never copy placeholder blanks into production.
2. Review existing duplicate withdrawal idempotency keys before applying the unique index. Initialization fails rather than deleting historical records to make the migration pass.
3. Backup the database and run integration tests against an isolated copy. No production migration, deployment, secret rotation or data rewrite was performed in this task.
4. If legacy shared signing secrets were ever active, rotate them and invalidate existing sessions. Removing source fallbacks alone does not revoke an explicitly configured compromised key.
5. Configure TRUST_PROXY for the actual ingress; verify forwarded-header normalization on the deployed platform.

## Remaining work; not a certification of optimality
- Full-snapshot writes and full-table reads still limit throughput. Replace these incrementally with operation-specific repositories/transactions, with regression evidence before changing behavior.
- Order ingestion/provider pagination needs verification against the actual provider contract and credentials. No guessed pagination protocol was introduced.
- A durable webhook inbox and provider-specific replay policy remain necessary. Existing token/HMAC compatibility was retained; timestamp-less requests have not been globally disabled.
- Migrate DDL out of request startup; add financial/domain CHECK/FK constraints after auditing existing data.
- Finish relational round-trip mapping for claim metadata, compound provider order identity, and durable transactional audit coverage.
- Financial transitions currently retain snapshot/OCC protection; migrate all paid/refund/admin adjustments to explicit command transactions. Global mutable in-process state remains a concurrency/maintenance concern beyond the tested inter-process scenarios.
- Validate production backup/PITR, deployment SLOs and partner synchronization completeness before release approval.

## Running PostgreSQL tests
Set PG_TEST_URL to an explicitly local test server, for example postgresql://test_user@127.0.0.1:55439/postgres, then run npm run test:postgres. The test creates a uniquely named aff_integration_* database and drops only that database after closing its workers. The test account needs CREATE DATABASE permission. Do not point this command at shared production infrastructure.
