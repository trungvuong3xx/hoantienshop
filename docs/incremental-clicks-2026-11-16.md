# Incremental click persistence and account quotas — 2026-11-16

## Changes
- Conversion saves only newly generated clicks with a parameterized, atomic PostgreSQL INSERT using jsonb_to_recordset. The cache is updated after successful persistence. An empty conversion result performs no database write.
- Replaying the same click ID does not duplicate database or cache records. Local JSON mode remains supported.
- Click inserts are independent of financial snapshot versions: snapshot synchronization only inserts clicks with ON CONFLICT DO NOTHING and does not delete them. Integration tests verify that an older snapshot cannot remove a newly inserted click.
- Redirects and ingestion paths can retrieve missing clicks by primary key from PostgreSQL. Webhooks on a different instance preserve user attribution. Cache retention is pruned at most once per minute during click insertion.
- Conversion quotas: 30 requests/minute per authenticated account; guests share 30 requests/minute per IP. An additional ceiling of 600 requests/minute per IP protects the endpoint. These are request quotas, not a hard 100-links/day limit. Bulk requests can contain multiple links.
- Production conversion limits fail closed when distributed rate limiting is unavailable, consistent with the existing security requirements. Redis must be configured before deployment.

## Verification
- npm test: 21/21 suites passed.
- npm run test:postgres: nine scenarios passed, including cross-instance click attribution, duplicate inserts, old-snapshot preservation and forced database insert failure without phantom cache publication.
- Real HTTP quota test: 40 requests across 20 accounts sharing one IP all succeeded. The same account then received 28 successes and seven HTTP 429 responses after its two earlier requests, confirming its 30-request quota.

## Capacity comparison
Same local PostgreSQL setup, seed of 60,000 recent links, 20 concurrent request workers. Provider response modeled with a 100 ms delay; log output muted; throughput stage bypasses limits in the harness only. No real provider requests were made. The newer run has an additional single-account quota control stage. This is a local closed-loop benchmark, not a production SLO certification.

| Metric | Before | After |
|---|---:|---:|
| 2,000 conversions, wall time | 283.15 s | 11.78 s |
| Conversion p95 | 3,029.19 ms | 126.82 ms |
| Conversion p99 | 3,274.64 ms | 163.52 ms |
| New records persisted | 2,000 | 2,000 |
| 100,000 redirect p95 | 16.71 ms | 20.25 ms |
| Incorrect redirect results | 0 | 0 |

Conversion p95 improved by approximately 24x. Redirect latency did not improve in this run; its p95 increased by about 3.5 ms and all redirects remained correct. Do not generalize conversion gains to every route.

Raw measurements: capacity-results-2026-11-16.json and capacity-results-incremental-2026-11-16.json.
Reproduce with PG_TEST_URL pointing to a dedicated localhost test PostgreSQL server and `node tests/load.capacity.js`.

## Remaining limits
Financial mutations still use snapshot/OCC; this change only removes snapshots from the conversion write path. Cache misses, actual provider latency and quotas, production Redis, hosted network/cold starts, realistic financial history, and mixed multi-instance throughput need further measurement. No production deployment or secret changes were performed. The temporary PostgreSQL server was stopped after testing.
