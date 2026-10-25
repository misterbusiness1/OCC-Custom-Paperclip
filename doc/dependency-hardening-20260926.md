# Stable upgrade dependency hardening — 2026-09-26

## Maintenance follow-up — 2026-10-25

The follow-up candidate sets these patched floors in both override manifests:

| Package | Resolution |
| --- | --- |
| fast-uri | 3.1.9 |
| ip-address | 10.7.4 |
| smol-toml | 1.9.0 |
| fast-copy 4.x | 4.1.0 |
| postcss-selector-parser | 7.1.6 |
| Vitest | 4.1.12 in each workspace manifest |

The workspace YAML mirror also receives the existing root security overrides.
This prevents newer pnpm clients from resolving below the root manifest's floors.
The declared package manager remains pnpm 9.15.4.

smol-toml 1.9 returns tables with null prototypes. Codex startup trust now keeps
that table shape when it changes the selected project. It still checks the exact
semantic change before it writes a file. Existing tests cover retained comments,
multiline strings, inline tables, worktrees, symlinks, and repeated calls.

The local production audit reports zero moderate, high, or critical findings.
Two low findings remain: the `cli` importer-name collision described below and
the KaTeX prototype-pollution trust advisory. This candidate does not suppress
either finding. The audit result is not a staging or production qualification.

Verify with `corepack pnpm audit --prod --json`, the Codex startup-trust suite in
`packages/paperclip-runner`, and the UI build. Generate the lockfile for local
verification; CI retains ownership of the committed lockfile.

The excluded TypeSafe skill-suggestion plugin owns a separate package-local
lockfile. Keep that lockfile aligned with its exact Vitest version. Docker runs
`pnpm --dir packages/plugins/plugin-typesafe-skill-suggestion install
--ignore-workspace --frozen-lockfile`; a root lockfile refresh cannot fix a
package-local mismatch. The root lockfile remains owned by CI.

## Original upgrade

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
