# Contributing to Safora

Thank you for your interest in contributing! This document outlines how to get started.

## Getting Started

1. **Fork** the repository and clone your fork.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Copy the environment example and fill in your values:
   ```bash
   cp .env.example .env
   ```

## Development Workflow

### Building

```bash
pnpm run build
```

### Local development databases

The integration tests run against real MongoDB, PostgreSQL, and MinIO (S3-compatible) instances. The easiest way to spin them all up is via Docker Compose:

```bash
# Start MongoDB, PostgreSQL, and MinIO (stays up until you stop it)
docker compose -f docker-compose.test.yml up -d --wait

# Tear down (removes volumes too)
docker compose -f docker-compose.test.yml down -v
```

The services are then reachable at:

| Service    | Default address                                          |
| ---------- | -------------------------------------------------------- |
| MongoDB    | `mongodb://localhost:27017`                              |
| PostgreSQL | `postgresql://postgres:postgres@localhost:5433/postgres` |
| MinIO      | `http://localhost:9000` (console: `http://localhost:9001`) |

Copy `.env.example` to `.env` and set `ENGINE`, `MONGODB_URI` or `POSTGRESQL_URI`, and the `S3_*` variables to point at these local instances for a `pnpm run backup:local` run.

### Running Tests

```bash
# Unit tests (no external services needed)
pnpm test

# Integration tests (requires Docker services above to be running)
pnpm run test:integration
```

### Linting & Formatting

```bash
# Check for lint errors
pnpm run lint

# Format code
pnpm run format

# Check formatting without writing
pnpm run format:check
```

### Type Checking

```bash
pnpm run typecheck
```

## Submitting Changes

1. Create a new branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Make your changes and ensure all checks pass:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`
   - `pnpm run format:check`
3. Commit using a clear, descriptive message (conventional commits are preferred):
   ```
   feat: add support for incremental backups
   fix: handle connection timeout gracefully
   docs: update environment variable reference
   ```
4. Push your branch and open a **Pull Request** against `main`.
5. Fill in the PR description with a summary of your changes and any relevant context.

## Code Style

- TypeScript is used throughout — avoid `any` where possible.
- Code is formatted with [Prettier](https://prettier.io/) and linted with [ESLint](https://eslint.org/).
- Run `pnpm run format` before committing.

## Reporting Bugs

Please open a GitHub Issue with:
- A clear description of the problem.
- Steps to reproduce.
- Expected vs. actual behaviour.
- Relevant logs or error messages.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
