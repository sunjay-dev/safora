## Problem Statement

Currently, the backup pipeline relies on unit tests with mocked filesystem calls, mocked database tools, and simulated AWS SDK calls. Because there is
no end-to-end integration test harness executing against real database engines and a live S3 destination:

1. Regressions in database discovery, CLI argument formatting for native database tools, or connection string handling can go undetected until a
   scheduled backup run fails in production.
2. S3 multipart delivery, path-style endpoint negotiation, and retention pruning behavior cannot be verified against a live S3 protocol implementation
   without incurring cloud costs or touching live storage.
3. Developers cannot verify full-pipeline behavior locally before pushing code or opening pull requests, and CI does not test complete database-to-S3
   runs.
4. There is no automated verification that produced encrypted archives can actually be decrypted and restored back to valid database data.

## Solution

Implement an automated end-to-end integration test suite and CI workflow using live containerized services (MongoDB, PostgreSQL, and MinIO for S3
emulation):

1. Define a unified Docker Compose service definition that spins up MongoDB, PostgreSQL, and MinIO with pre-configured credentials, healthchecks, and
   bucket initialization.
2. Provide a production-compatible test runner environment based on Ubuntu 24.04 with pinned versions of Node.js, MongoDB Database Tools, PostgreSQL
   client utilities, and the age encryption tool.
3. Test the backup pipeline at the highest possible architectural seam by executing the compiled production CLI entry point (`node dist/main.js`) as a
   real child process with real environment variables.
4. Validate multi-database discovery and blocklist exclusions against live databases, asserting that each eligible database produces a distinct
   encrypted archive while blocklisted databases are excluded.
5. Perform end-to-end round-trip recovery verification: download archives from MinIO, decrypt them with age, and verify data parity against the seeded
   source databases.
6. Verify live S3 retention pruning against MinIO by asserting that expired archives are removed while current archives are retained.
7. Integrate the suite into a dedicated GitHub Actions CI workflow running on pull requests and pushes, completely isolated from the scheduled
   production backup workflow.

## User Stories

1. As a platform maintainer, I want integration tests to run against a real local S3-compatible service, so that delivery and retention can be
   verified without requiring external cloud provider credentials.
2. As a platform maintainer, I want MinIO configured with path-style addressing and automatic bucket initialization, so that the S3 destination client
   connects and uploads without manual infrastructure setup.
3. As a platform maintainer, I want integration tests to execute against a live MongoDB instance, so that mongodump execution, database enumeration,
   and archive creation are validated against real database protocols.
4. As a platform maintainer, I want integration tests to execute against a live PostgreSQL instance, so that psql and pg_dump operations, database
   enumeration, and archive creation are validated against real database protocols.
5. As a developer, I want to run the full integration suite locally with a single command, so that I can validate changes before pushing to remote
   branches.
6. As a developer, I want integration tests to run in a containerized runner matching the production venue, so that I do not need native database
   tools or specific client versions installed on my host machine.
7. As a developer, I want the option to run the integration test suite directly on my host against exposed container ports, so that I have flexibility
   when debugging individual test cases.
8. As a CI operator, I want GitHub Actions to use the exact same Docker Compose definition used locally, so that there is zero configuration drift
   between local testing and CI runs.
9. As a platform maintainer, I want integration tests to execute the compiled production CLI entry point as a real child process, so that
   configuration loading, validation schemas, loggers, and exit codes are exercised without mock abstractions.
10. As a platform maintainer, I want the integration runner to capture stdout, stderr, process exit codes, and execution duration from the child
    process, so that failures provide full diagnostic traces.
11. As a platform maintainer, I want process timeouts enforced on child process executions, so that hanging database connections or tool deadlocks
    fail quickly and cleanly.
12. As a database administrator, I want multi-database test fixtures seeded across both engines, so that dynamic database discovery is verified
    against realistic multi-tenant environments.
13. As a database administrator, I want blocklist configuration validated against live database engines, so that blocklisted databases are never
    dumped, encrypted, or delivered.
14. As a database administrator, I want separate encrypted archives delivered for each eligible database, so that databases can be restored
    independently.
15. As a security engineer, I want all delivered archives in MinIO verified to be age-encrypted, so that plaintext dumps are never written to offsite
    destinations.
16. As a security engineer, I want the integration suite to verify round-trip restore capability by downloading archives, decrypting them, and
    restoring the contents, so that backup recoverability is proven end-to-end.
17. As a storage operator, I want live retention pruning verified against MinIO, so that expired archives are purged according to retention policy
    without touching active or current run archives.
18. As a developer, I want unit tests (`pnpm test`) to remain fast, isolated, and container-free, so that day-to-day TDD workflows are never slowed
    down by integration infrastructure.
19. As a CI maintainer, I want the integration test workflow separated from the production backup workflow, so that pull requests and branch builds
    never trigger production backup runs.
20. As a CI maintainer, I want integration test containers and ephemeral volumes cleanly destroyed upon test completion in CI, so that runners remain
    clean and prevent disk exhaustion.

## Implementation Decisions

- **Single Infrastructure Definition**: The test services (MinIO S3 service, MongoDB database, PostgreSQL database, and an initialization helper to
  create the test S3 bucket) are declared in a single Compose file. This serves as the single source of truth for service ports, environment
  variables, credentials, and container healthchecks across both local runs and CI workflows.
- **Dedicated Test Runner Container**: A separate test runner Docker image based on Ubuntu 24.04 pins Node.js 22, MongoDB Database Tools 100.15.0,
  PostgreSQL 17 client utilities, and the age encryption CLI. This image builds the application using the existing project build command and executes
  tests against the compiled output, matching the exact binary environment of production GitHub Actions runs.
- **Single Process Seam**: The integration tests interact with the application solely through the compiled CLI entry point spawned as a child process.
  The child process receives its configuration strictly via process environment variables, matching the venue runtime contract in production.
- **Dedicated Integration Test Suite**: Integration test files are segregated from existing unit tests into a dedicated test folder and script. Unit
  tests remain zero-dependency and sub-second; integration tests handle database connectivity, archive round-tripping, and S3 communication with
  appropriate execution timeouts (e.g., 30–60 seconds).
- **Multi-Database Test Fixtures**:
  - MongoDB test fixtures seed at least two eligible databases (e.g. `tenant_a`, `tenant_b`) and one blocklisted database (e.g. `analytics_staging`).
  - PostgreSQL test fixtures seed at least two eligible databases (e.g. `tenant_a`, `tenant_b`) and one blocklisted database (e.g.
    `analytics_staging`).
- **Engine-Specific Blocklist Verification**:
  - For MongoDB, configuration passes the blocklisted database name to `MONGODB_DB_BLOCKLIST`.
  - For PostgreSQL, configuration passes the blocklisted database name to `PG_DB_BLOCKLIST`.
- **End-to-End Verification Pipeline**:
  - Pre-run: Seed test databases with structured documents/tables.
  - Run: Execute CLI child process for `ENGINE=mongodb` and `ENGINE=postgres`.
  - Verification: Inspect MinIO bucket for expected archive object keys; verify absence of blocklisted database object keys; download archives;
    decrypt using age private key; restore or inspect archive payloads to confirm document/table row integrity.
- **Live Retention Verification**: Synthetic archive objects with simulated expired timestamps are seeded into the MinIO destination, and retention
  pruning is triggered to verify that expired archives are removed via batch delete operations while active archives remain untouched.
- **Dedicated CI Workflow**: A new GitHub Actions workflow triggers on push to main branches and on pull requests. It starts the test services, waits
  for healthchecks, executes the containerized test suite, captures failure logs, and ensures volume cleanup. The existing production backup workflow
  remains untouched.

## Testing Decisions

- **What makes a good test**: Tests must evaluate observable external behavior at the system boundary rather than internal function calls or state.
  Success is measured by process exit codes, structured log output, object presence/absence in S3, encryption integrity, and complete database
  restorable state.
- **Modules tested**:
  - Configuration parsing and validation schema (`src/config/env.config.ts`)
  - Subprocess execution and CLI tool wrappers (`src/lib/exec.ts`, `src/steps/dump.ts`, `src/lib/postgres.ts`)
  - Streaming encryption and age recipient handling (`src/steps/encrypt.ts`)
  - S3 client creation, multipart delivery, and checksum verification (`src/storage/client.ts`, `src/storage/upload.ts`, `src/destinations/s3.ts`)
  - S3 retention candidate discovery, pagination, and batch deletion (`src/storage/retention.ts`, `src/storage/retention-policy.ts`)
  - End-to-end engine orchestrators and run summary reporting (`src/main.ts`, `src/summary.ts`)
- **Prior art**:
  - `src/main.test.ts`: Tests multi-database flows using stubbed database CLIs and simulated destination stubs. The new integration suite replaces
    stubbing with live containerized endpoints.
  - `src/storage/client.test.ts`: Verifies S3 client configuration, path-style flags, and custom endpoints. The integration suite validates these
    against live MinIO.
  - `src/destinations/s3.test.ts` & `src/storage/retention.test.ts`: Unit tests verifying upload and retention pagination. The integration suite
    validates these against live S3 API responses.

## Out of Scope

- Testing secondary cloud storage providers (AWS S3, Cloudflare R2, Backblaze B2) over the public internet; MinIO provides full S3 API protocol
  fidelity locally.
- Modifying or refactoring existing production backup workflow logic in `.github/workflows/backup.yml`.
- Supporting or testing database engines other than MongoDB and PostgreSQL.
- Testing non-standard authentication methods (e.g. Kerberos, LDAP, x509 certificates) for test databases.
- Restoring live database clusters in production environments; restore testing is limited to test containers.

## Further Notes

- The integration test suite uses Docker Compose healthchecks (`test: ["CMD", ...], interval: 2s, timeout: 5s, retries: 10`) to guarantee databases
  and MinIO are accepting connections before tests begin.
- The test suite uses temporary age keypairs generated during test execution, ensuring tests never require or expose real secrets.
