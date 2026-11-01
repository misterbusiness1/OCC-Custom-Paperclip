# @paperclipai/plugin-sdk

## Unreleased

### Breaking changes for plugin source code

- The `z` re-exported by `@paperclipai/plugin-sdk` is now zod 4 (the `zod`
  package root, pinned to 4.6.7) instead of zod 3. Plugins that are already
  built keep working, because manifests carry JSON Schema and host and worker
  exchange JSON; plugin code that uses `z` must follow the zod 4 API when it is
  rebuilt against this SDK. The "Zod 4" section of the README lists the
  changes most likely to matter (`.issues` instead of `.errors`, two-argument
  `z.record()`, defaults under `.optional()`/`.partial()`, `.prefault()`,
  required bare `z.unknown()` keys, strict `z.uuid()`, `.datetime()` seconds).
- `PLUGIN_API_VERSION` is unchanged.
- Versioning: the exported `z` changes its major version, so the next
  published release of this package must be a semver-major bump (2.0.0; the
  manifest still says 1.0.0 because this fork does not publish it).
