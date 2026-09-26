# Stable upgrade dependency hardening — 2026-09-26

The v2026.916.1 fork candidate retains the deployed immutable runtime skill snapshot fix and pins the qualified global CLIs: Claude Code 2.1.283, Codex 0.157.1, and Kimi Code 2.1.1. The external Kimi plugin is separately deployed as 1.0.5. Existing ACP bridge patches and qualified SDK pins remain unchanged.

Production dependency fixes:

| Package | Resolution |
| --- | --- |
| fast-uri | 3.1.6 |
| js-yaml | 4.3.2 |
| multer | ^2.3.0 |
| qs | 6.16.0 |
| body-parser | 2.3.0 |
| hono | 4.13.5 |
| form-data 4.x (development dependency audit) | 4.0.6 |
| uuid, only below svix 1.76.1 | 11.1.1 |
| esbuild, only below @esbuild-kit/core-utils 3.3.2 | 0.25.12 |

Both override manifests must stay synchronized. The UUID override preserves CommonJS support and the v4 API used by Svix. The esbuild override targets Drizzle's legacy ESM loader; other esbuild resolutions remain owned by their consumers.

The regenerated production and development audits report zero critical/high/moderate findings and one low finding for npm `cli@0.3.1` (GHSA-6cpc-mj5c-m9rq). This is an importer-name collision: the workspace directory `cli` is package `paperclipai@0.3.1`; neither the lockfile package inventory nor `pnpm list -r cli --depth Infinity` contains the unrelated npm `cli` package. Do not install npm `cli` or rename the product to silence this finding. No global audit suppression is configured.

High-severity references: [fast-uri](https://github.com/advisories/GHSA-5jgf-p345-68v8), [js-yaml](https://github.com/advisories/GHSA-2883-xcg3-v3hh), [multer](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm).

The lockfile is generated locally for a frozen deployment build and saved with deployment evidence. Per repository policy it is not included in this source commit. CI owns the committed lockfile.

This change adds no migrations. The underlying stable upgrade still requires the existing migration rehearsal, fresh backup, compatibility environment settings and an idle cutover window. Passing the dependency audit alone does not authorize a readiness claim.

The full dependency audit also identified development-only `form-data@4.0.5`; its scoped override fixes [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx).
