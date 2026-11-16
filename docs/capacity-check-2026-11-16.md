# Capacity check — 2026-11-16

## Workload
20 concurrent request workers; target 5,000 outbound clicks and 100 single-link conversions per user per day. Assuming 20 daily users, that is 100,000 clicks and 2,000 conversions/day. Seed: 60,000 recent click records (30 days of conversions), 20 synthetic users plus the bootstrap admin. No representative order/ledger history was included.

## Method
One Node application process, separate load generator process, local PostgreSQL 18.7. All provider credentials excluded. Canonical Shopee product links use the application's an_redir path, with an injected 100 ms wait in the provider conversion adapter. No real provider calls, short-link DNS resolution, network failures or upstream throttling were exercised. Application logger functions muted for the benchmark. Tests do not modify application rate limits; a harness-only switch bypasses the limiter for saturation measurement after an initial real-limiter control test.

The UI currently links directly to item.affiliateUrl (public/app.js). Those outbound clicks ordinarily bypass this application. The /go test therefore covers an additional server-redirect scenario, not an assertion that every UI click hits the server.

## Observed results
| Stage | Requests | Concurrency | p50 | p95 | p99 | Result |
|---|---:|---:|---:|---:|---:|---|
| Real limiter, one IP | 40 | 1 | 1,378 ms | 1,435 ms | 1,494 ms | 30 successful conversions, 10 HTTP 429 |
| Redirect through /go | 100,000 | 20 | 7.37 ms | 16.71 ms | 23.61 ms | 100,000 correct 302 destinations, no invalid responses |
| Conversion, harness limiter bypass | 2,000 | 20 | 2,817 ms | 3,029 ms | 3,275 ms | 2,000 successful results and 2,000 additional PostgreSQL click records |

Redirect stage: 41.74 seconds, approximately 2,396 requests/second.
Conversion stage: 283.15 seconds, approximately 7.06 requests/second.
Application RSS after stages: approximately 266 MiB (redirect) and 319 MiB (conversion); these are endpoint samples, not peak memory.
Database size at completion: 37,844,671 bytes; not a production storage estimate.
Event-loop p99 during conversion: 110.89 ms; maximum observed 384.57 ms.

## Interpretation
The daily totals fit within the measured local synthetic throughput, but this is not a production capacity certification. The conversion tail latency needs improvement if a sub-second interaction is desired. The full-snapshot path repeatedly submits the existing click history, making per-request persistence cost depend on accumulated data. Prioritize incremental click inserts and an appropriate read path before introducing additional infrastructure.

The live limiter is IP-based: 20 users sharing one NAT/IP share the 30-conversions/minute quota. Daily totals alone do not establish that burst admission requirements are met. Revisit an authenticated per-user quota plus an IP abuse limit, with explicit policy and regression tests.

Remaining validation: actual provider latency/quota/error handling, normal logging overhead, realistic financial history, hosted network/cold starts, multi-instance and open-loop arrival/load tests, production-equivalent Redis limiter, and mixed simultaneous redirects/conversions. The stages here are separate closed-loop runs and do not model all those conditions.

## Reproduce
Use a dedicated localhost PostgreSQL test server with CREATE DATABASE permission. Set PG_TEST_URL and optionally CAPACITY_REPORT, then run `node tests/load.capacity.js`. The harness creates and drops its own uniquely named aff_capacity_* database. It does not use .env or production data. The temporary PostgreSQL server used for this run was stopped after completion.
