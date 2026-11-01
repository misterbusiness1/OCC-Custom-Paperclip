# Agent Runtime Image Family

Container images for running coding-agent harnesses in sandboxed environments (for example the kubernetes sandbox provider, stage 1 of the k8s contribution). Images are named `agent-runtime-{harness}:{version}` and published by the `agent-runtime-images` workflow to the GHCR namespace of the repository owner that runs it, `ghcr.io/<owner>/` lowercased (upstream: `ghcr.io/paperclipai/`; see [Publishing](#publishing)). The registry is overridable: every reference flows through the `REGISTRY` bake variable, whose local default is `ghcr.io/paperclipai`.

## Image Lineup

- **`agent-runtime-base`**: Foundation. Ubuntu 22.04 + Node 22 + git + tini + non-root user (uid 1000) + the agent shim.
- **`agent-runtime-opencode`**: Extends base with `opencode-ai` globally installed.
- **`agent-runtime-pi`**: Extends base with `@mariozechner/pi-coding-agent`.
- **`agent-runtime-codex`**: Extends base with `@openai/codex`.
- **`agent-runtime-gemini`**: Extends base with `@google/gemini-cli` plus headless auth-mode settings.
- **`agent-runtime-claude`**: Extends base with `@anthropic-ai/claude-code` (symlinked as `claude-code`).
- **`agent-runtime-hermes`**: Dockerfile included in the bake group, not in the default publish scope (stub until a CLI package exists).

## Base Image Contents

**OS & Runtime:**
- Ubuntu 22.04
- Node.js 22 (via NodeSource APT repo)
- git
- tini (PID-1 init, ensures signal propagation)
- Non-root user `paperclip` (uid/gid 1000)

**Paperclip Binaries:**
- `/usr/local/bin/paperclip-agent-shim`: Go binary compiled from `tools/agent-shim/`. Reads `/run/paperclip/runtime-command.json` and `syscall.Exec`s the harness CLI.

**Defaults:**
- `USER`: 1000:1000 (paperclip, non-root)
- `WORKDIR`: `/workspace` (mount workspace volumes here)
- `ENTRYPOINT`: `/usr/bin/tini --` (PID-1 reaper, forwards signals)
- `CMD`: `/usr/local/bin/paperclip-agent-shim`

## Building Locally

All targets build `linux/amd64` by default (see `buildx-bake.hcl`). Derived images chain off the `base` target through bake `contexts`, so the literal registry in each `FROM` line is overridden at build time and the whole family builds in one pass without pushing intermediates.

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --load
```

### Custom tag or registry

```bash
REGISTRY=myregistry VERSION=mytag \
  docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --load
```

## Quickstart Smoke Test

Build and verify the `agent-runtime-claude` image runs locally:

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl base claude --load
docker run --rm ghcr.io/paperclipai/agent-runtime-claude:dev claude-code --version
```

## Agent Container (paperclip-agent-shim)

The main agent process runs as the shim (PID 1 under tini). The shim:

1. Reads `/run/paperclip/runtime-command.json` (path overridable via `-spec`), a JSON file mounted by whatever schedules the run
2. Parses `{ "command", "args" }`: the harness CLI and arguments
3. Resolves the command on PATH and `syscall.Exec`s it, replacing itself
4. SIGTERM from the kubelet propagates directly to the harness (no zombie processes)

**runtime-command.json Contract:**
```json
{
  "command": "claude-code",
  "args": ["--token", "xyz", "--workspace", "/workspace"]
}
```

The shim makes no assumptions about command structure; it is harness-agnostic. New harnesses swap the command/args; the base image stays the same.

## Security Model

- **Non-root execution**: user 1000:1000, no capability grants
- **PSS Restricted compatible**: no privileged containers, no host mounts; works with a read-only root filesystem (writable `/workspace` + `/tmp` mounts)
- **No secrets baked in**: API tokens and credentials come from per-run ephemeral Secrets mounted as env vars or files
- **Image signing**: cosign keyless OIDC in the publish workflow

## Publishing

`.github/workflows/agent-runtime-images.yml` builds and pushes the default scope (base, opencode, pi, codex, gemini, claude) on `workflow_dispatch` (with an explicit version tag) or on pushes to `master` touching these paths, then signs each digest with cosign keyless OIDC.

- **Registry**: `ghcr.io/<owner>`, where `<owner>` is the lowercased owner of the repository running the workflow (`github.repository_owner`). Upstream this is `ghcr.io/paperclipai`; a fork publishes to its own namespace, because its `GITHUB_TOKEN` cannot push to `ghcr.io/paperclipai`.
- **Tags**: pushes to `master` publish `git-<sha>`; `workflow_dispatch` publishes the `version` input (default `dev`). No `v1` tag is published unless you dispatch with `version: v1`.
- **Visibility**: GitHub gives a newly published GHCR package private visibility by default, including packages under a personal account such as a fork owner's. After the first run, either switch each `agent-runtime-*` package to public in its package settings ("Change visibility") or give the cluster a pull secret through the kubernetes provider's `imagePullSecrets`.

### Using a fork's images with the kubernetes sandbox provider

The provider's built-in defaults pull `ghcr.io/paperclipai/agent-runtime-{harness}:v1` (`packages/plugins/sandbox-providers/kubernetes/src/adapter-defaults.ts`), so images this workflow publishes to a fork's namespace are not used until the environment config points at them. Set the `adapters` registry with an explicit `runtimeImage` for each adapter type the environment runs, for example `ghcr.io/<owner>/agent-runtime-claude:git-<sha>`. The registry has replace semantics: once `adapters` is set, any adapter type not listed in it is rejected.

The `imageRegistry` setting rewrites only the registry and owner and keeps the default `:v1` tag, so it also needs a `v1` tag in your namespace. It is validated as a URL, so a bare `ghcr.io/<owner>` value is rejected; prefer `adapters`.
