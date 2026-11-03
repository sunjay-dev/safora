# Contributing to mongodb-backups

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

### Running Tests

```bash
# Unit tests
pnpm test

# Integration tests (requires a running MongoDB instance via Docker)
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
