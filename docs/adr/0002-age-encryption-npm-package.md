# Use the age-encryption npm package instead of the age CLI binary

The encrypt step uses the `age-encryption` TypeScript package — written by Filippo Valsorda, the author of age itself, on the audited `@noble/*`
libraries — rather than shelling out to the Go `age` binary. Artifacts are format-identical: verified byte-for-byte against the CLI on a real pipeline
artifact (both decrypt to the same archive), so disaster recovery still uses the plain `age` CLI with the offline key, unchanged. This removes an
external binary from the toolchain — no local `age` install needed (the binary was missing on the maintainer's Windows machine, blocking local runs) —
and CI drops its install step. The trade-off is a pre-1.0 npm dependency in the encrypt path, accepted because its dependency tree is essentially just
the noble libraries and the lockfile is frozen.

## Considered Options

- **Keep the age CLI binary**: rejected — a recurring setup blocker on local machines for zero functional gain, given verified interoperability. The
  CLI remains the documented restore tool, since any recovery machine can run it against the same files.
