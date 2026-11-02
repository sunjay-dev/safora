# S3-compatible storage abstraction and legacy R2 deprecation path

Storage delivery and retention are unified under a single S3-compatible destination (`id: "s3"`) rather than provider-specific adapters. All major
object storage targets (AWS S3, Cloudflare R2, MinIO, Ceph, Wasabi, Backblaze B2) implement the S3 protocol. The pipeline interacts with storage using
`@aws-sdk/client-s3` and `@aws-sdk/lib-storage` directly for multipart uploads, HeadObject size verification, and ListObjectsV2/DeleteObjects
retention pruning.

Canonical configuration standardizes on `S3_*` environment variables (`S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, and `S3_FORCE_PATH_STYLE`), and `DESTINATIONS` accepts `s3` (default) and `local`.

## Backward compatibility strategy

The repository was initially coupled to Cloudflare R2 (`DESTINATIONS=r2`, `R2_*` environment variables). To generalize storage without breaking
existing deployments:

- **Canonical destination**: The canonical offsite destination identifier is `s3`. The legacy `r2` identifier in `DESTINATIONS` is deprecated and
  retired from the application's destination parser (valid destinations are strictly `s3` and `local`).
- **Workflow-level secret fallback**: `.github/workflows/backup.yml` maps legacy `R2_*` secrets and variables (`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) as fallback inputs to the canonical `S3_*` environment variables
  (`${{ secrets.S3_ENDPOINT || secrets.R2_ENDPOINT }}`, `${{ vars.S3_BUCKET || vars.R2_BUCKET }}`). Existing repositories configured with Cloudflare
  R2 secrets continue running with zero downtime and no immediate manual migration required, while new setups configure canonical `S3_*` secrets.

## Credential resolution

The S3 client factory supports two credential modes:

- **Explicit static credentials**: If either `S3_ACCESS_KEY_ID` or `S3_SECRET_ACCESS_KEY` is provided, both are strictly required (enforcing an
  all-or-nothing boundary). When provided, explicit static credentials are passed directly to `S3Client`.
- **Ambient credential resolution**: If neither `S3_ACCESS_KEY_ID` nor `S3_SECRET_ACCESS_KEY` is provided, `credentials` is omitted from the
  `S3Client` configuration. The AWS SDK default credential provider chain automatically resolves credentials from ambient execution venues, including
  IAM instance profiles, ECS/EKS task roles, AWS SSO, GitHub Actions OIDC via STS AssumeRoleWithWebIdentity, or local `~/.aws/credentials` profiles.

## Region and endpoint resolution

- `S3_ENDPOINT` is optional; it is omitted when targeting native AWS regional endpoints and supplied for custom endpoints (such as Cloudflare R2 or
  MinIO). Trailing slashes are stripped during normalization.
- `S3_REGION` is explicitly configurable (for example, `auto` for Cloudflare R2 or AWS regions like `us-east-1`). When unset, region configuration is
  omitted on `S3Client`, delegating to the AWS SDK ambient resolution (e.g. `AWS_REGION` or SDK default config).
- `S3_FORCE_PATH_STYLE` is parsed as an optional boolean (defaulting to `false`). Operators set this to `true` for self-hosted S3-compatible systems
  like MinIO or LocalStack that require path-style bucket access (`http://endpoint/bucket/key`).

## Considered Options

- **Separate per-provider adapters** (e.g., dedicated `r2.ts`, `s3.ts`, `minio.ts`, `wasabi.ts`): rejected — all supported services share the S3 wire
  protocol. Multiple destination adapters would introduce duplicate upload, checksum verification, error handling, and retention pruning logic with
  zero behavioral differences. A single configurable S3 destination handles all S3-compatible providers through endpoint, region, credential, and
  path-style options.
- **Presence-based destination activation** (automatically activating S3 or local destination if environment variables exist, rather than requiring
  explicit `DESTINATIONS`): rejected — per ADR-0001, a backup system must fail loudly if a configured destination's required secrets are missing,
  rather than silently proceeding without offsite delivery.
- **In-tree STS / IAM role assumption logic**: rejected — delegating credential resolution to the AWS SDK default provider chain natively supports IAM
  roles, ECS task roles, and GitHub Actions OIDC without adding custom STS client code, token exchange handlers, or additional maintenance overhead.
