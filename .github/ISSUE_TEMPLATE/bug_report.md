---
name: Bug Report
about: Report something that isn't working correctly
title: "fix: "
labels: needs-triage
assignees: sunjay-dev
---

## Describe the bug

A clear and concise description of what the bug is.

## Steps to reproduce

1. Set `ENGINE=...`
2. Run `pnpm run backup:local`
3. See error: `...`

## Expected behaviour

What you expected to happen.

## Actual behaviour

What actually happened. Include the relevant log output (structured JSON lines are fine — paste as a code block). If credentials appear in the logs, redact them before pasting.

## Environment

- OS: <!-- e.g. Ubuntu 24.04, macOS 15, Windows 11 -->
- Node.js version: <!-- node --version -->
- pnpm version: <!-- pnpm --version -->
- Engine: <!-- mongodb / postgres -->
- Storage: <!-- AWS S3 / Cloudflare R2 / MinIO / local -->
- Running in: <!-- GitHub Actions / local -->

## Additional context

Add any other context about the problem here (e.g. database size, network conditions, relevant `.env.example` settings you changed).
