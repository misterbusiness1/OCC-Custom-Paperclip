# Runtime skill snapshots

Fallback runtime skills and pinned skill versions are published under a
`.snapshots/<sha256>` directory within their existing company-scoped runtime root.
The hash includes normalized file paths and contents. Writers build a private
temporary directory and rename it only after every file has been written.
Concurrent writers reuse the complete winning directory.

Adapters receive the immutable directory path. A `current` symlink supports
read-only discovery and is replaced atomically; adapters do not retain that link.
Changing a skill creates a new snapshot without removing the prior one. Existing
legacy materializations remain readable during deployment.

Snapshots are reused for unchanged content. Prior snapshots are retained until
the enclosing runtime materialization is explicitly removed by skill lifecycle
operations. Do not prune them while runs might still reference them. A corrupt
existing snapshot fails publication rather than deleting files an active run may
be using.

Regression coverage: `skill-runtime-snapshot.test.ts` tests concurrent publication,
unchanged-file reuse, changed content, removed files, legacy readers, and invalid
paths. `company-skills-service.test.ts` covers DB-backed fallback and read-only
discovery, including concurrent listing and retaining the previous version.
