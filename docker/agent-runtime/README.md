# Agent Runtime Image Family

Container images for running coding-agent harnesses in sandboxed environments (for example the kubernetes sandbox provider, stage 1 of the k8s contribution). Images are named `agent-runtime-{harness}:{version}` and published to `ghcr.io/paperclipai/` by the `agent-runtime-images` workflow. The registry is overridable: every reference flows through the `REGISTRY` bake variable.

## Image Lineup

- **`agent-runtime-base`**: Foundation. Ubuntu 22.04 + Node 24 + git + tini + non-root user (uid 1000) + the agent shim.
- **`agent-runtime-opencode`**: Extends base with `opencode-ai` globally installed.
- **`agent-runtime-pi`**: Extends base with `@mariozechner/pi-coding-agent`.
- **`agent-runtime-onecli`**: Internal managed-worker build dependency that adds a reviewed, hash-pinned native OneCLI executable to base.
- **`agent-runtime-codex`**: Extends base with `@openai/codex@0.164.0`.
- **`agent-runtime-gemini`**: Extends base with `@google/gemini-cli` plus headless auth-mode settings.
- **`agent-runtime-claude`**: Extends base with `@anthropic-ai/claude-code@2.1.308` (symlinked as `claude-code`).
- **`agent-runtime-hermes`**: Dockerfile included in the bake group, not in the default publish scope (stub until a CLI package exists).

- **`agent-runtime-codex-managed` / `agent-runtime-claude-managed`**: Opt-in variants of the same recipes that inherit the native OneCLI dependency.

## Base Image Contents

**OS & Runtime:**
- Ubuntu 22.04
- Node.js 24 (via NodeSource APT repo)
- git
- tini (PID-1 init, ensures signal propagation)
- Non-root user `paperclip` (uid/gid 1000)

The NodeSource install puts `node` on the default `PATH`. The agent shim in this
image runs the harness directly with that `PATH`. The shim does not source a
login profile, and the runtime never writes a profile or an rc file. Some
sandbox providers instead wrap each command in a login shell. That shell sources
`/etc/profile` and the user profile files to read an owner-supplied `PATH`. No
exec path sources `nvm`. For the full exec-path contract, see
`packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md`.

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

### Managed Codex and Claude: supply the reviewed native OneCLI artifact

The opt-in `managed-codex` and `managed-claude` targets require the BuildKit named context `onecli-cli`. Supply a
public artifact directory containing the native, CGO-disabled `linux/amd64`
executable named `onecli`. No source checkout, login state, management key,
provider profile, or credential file belongs in this context. Only `/onecli` is
copied; the existing runtime and execution entrypoint are preserved.

Pass the full reviewed CLI source commit, tree, and executable SHA256 explicitly:

```bash
ONECLI_CLI_CONTEXT=/path/to/reviewed/public-cli-artifact \
ONECLI_SOURCE_COMMIT=<reviewed-full-40-hex-commit> \
ONECLI_SOURCE_TREE=<reviewed-full-40-hex-tree> \
ONECLI_BINARY_SHA256=<reviewed-executable-sha256> \
  docker buildx bake -f docker/agent-runtime/buildx-bake.hcl identity-workers --load
```

The nonexistent default context and empty source/hash defaults intentionally
prevent a build without release inputs. Use the native bake context mapping;
a direct Docker build must supply the same named contexts explicitly. The build
checks source/hash syntax and uses `sha256sum` to verify the copied executable.
It also checks the native `onecli version` embedded commit against the source
argument with an empty private HOME/XDG configuration and network disabled.
The native version command attempts health even without a management credential;
`ONECLI_API_HOST=http://127.0.0.1:1` confines that attempt to a closed loopback
port, and the build requires its native `server_status` to be `unreachable`.
The release must independently bind that binary hash to its reviewed source and
build proof; an image label alone does not establish source provenance.

The resulting images record `io.paperclip.onecli.source-commit`,
`io.paperclip.onecli.source-tree`, and `io.paperclip.onecli.binary-sha256` labels.
Codex and Claude versions are fixed in bake arguments, so ambient host
`CODEX_VERSION` or `CLAUDE_VERSION` variables cannot silently change the build.
The initial versions match existing local `codex --version` and `claude --version`
evidence (0.164.0 and 2.1.308); updates require an explicit reviewed change.
Native version checks run without network during the build.

For a later native OneCLI version smoke test, use an empty private HOME and XDG
config directory, no `ONECLI_API_KEY`, and the same closed loopback
`ONECLI_API_HOST`. Its version command attempts server health even without
management credentials. No credentials are baked into these
images, and no authentication behavior, worker identity policy, or subscription
routing is changed here. Image builds and real isolated model/tool execution
still need separate qualification; this source change does not claim those pass.

Base, Gemini, OpenCode, Pi, and Hermes remain on their existing build paths.
The original default group and publishing workflow do not select managed
targets and need no OneCLI artifact. The `identity-workers` group selects only
the two distinct managed tags. After real worker qualification, configure the
worker registry with their immutable digests explicitly; this patch does not
activate or substitute them for existing workers. To inspect the recipe:

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --print identity-workers
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
