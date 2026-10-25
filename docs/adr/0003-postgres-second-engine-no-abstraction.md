# PostgreSQL as a second engine — parallel job, no abstraction layer

A second dump engine (PostgreSQL) runs as a second, independent job in the same scheduled workflow, selected by the `ENGINE` environment variable
(default `mongodb`) rather than through a shared engine abstraction — the downstream pipeline (encrypt → deliver → prune) is already engine-agnostic,
and a second engine alone did not justify a framework. The connection string is respected exactly as the operator provides it: any supported `sslmode`
is honored, no mode means PostgreSQL client defaults, invalid strings fail with a clear redacted error, and the string is never silently rewritten.
Deliberately deferred: global-role exports (would require a superuser secret; role recreation is documented in the restore checklist instead) and
automated restore verification.

Because the server is publicly reachable, libpq's default `sslmode=prefer` can fall back to an unencrypted connection — the docs state this trade-off
explicitly and recommend `sslmode=require` (or `verify-full` with certificate verification) for public endpoints rather than the pipeline enforcing
it.

## Considered Options

- **One job fanning out over engines** (mirroring destination fan-out): rejected — engines are independent databases, not redundant copies of the same
  data; coupling them shares a runner, timeout, and failure envelope.
- **A Destination-style engine abstraction**: rejected for now — two dump implementations behind a switch don't justify an interface; revisit when a
  third engine arrives.
- **Mandatory `sslmode` validation** (reject URIs without `require`+): rejected — it optimizes for a public endpoint at the cost of legitimate non-TLS
  targets (localhost, Docker, private networks) and overrides the operator's explicit connection choice; the trade-off is documented instead of
  enforced.
