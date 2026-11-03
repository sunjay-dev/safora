# Security Policy

## Supported Versions

Safora is a single-branch project. Security fixes are applied to the `main` branch only.

| Branch | Supported |
| ------ | --------- |
| main   | ✅        |

## Scope

Reports are welcome for issues in:

- **Credential handling** — connection strings, temporary config files, PGPASSFILE lifecycle
- **Encryption pipeline** — age encryption, key management, archive integrity
- **Secret redaction** — log sanitisation, error message scrubbing
- **S3 / storage** — upload integrity, retention, access-control assumptions
- **GitHub Actions workflows** — privilege escalation, secret exposure, supply-chain risks

Out of scope: vulnerabilities in upstream dependencies (report those to the dependency maintainer directly), or issues that require physical access to the machine running the backup.

## Reporting a Vulnerability

**Please do not open a public GitHub Issue for security vulnerabilities.**

Report security issues privately via [GitHub Security Advisories](https://github.com/sunjay-dev/safora/security/advisories/new). You will receive an acknowledgement within **48 hours** and a resolution or mitigation plan within **7 days** for critical issues.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Any suggested fix (optional but appreciated)

## Disclosure Policy

Once a fix is merged and released, the vulnerability will be disclosed in a GitHub Security Advisory with full credit to the reporter (unless anonymity is requested).
