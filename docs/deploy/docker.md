---
title: Docker
summary: Docker Compose quickstart
---

Run Paperclip in Docker without installing Node or pnpm locally.

## Compose Quickstart (Recommended)

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

Open [http://localhost:3100](http://localhost:3100).

Defaults:

- Host port: `3100`
- Data directory: `./data/docker-paperclip`

Override with environment variables:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `PAPERCLIP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

## Manual Docker Build

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## Data Persistence

All data is persisted under the bind mount (`./data/docker-paperclip`):

- Embedded PostgreSQL data
- Uploaded assets
- Local secrets key
- Agent workspace data

## Startup and health

When started as root, the entrypoint repairs ownership of writable data before
launching Paperclip as the `node` user. Large restored homes can take several
minutes. Container logs report ownership-scan progress and elapsed time; wait
for the scan to complete before treating a cold start as stalled.

The image allows six minutes of startup health grace. Probes run during that
period and can mark the container healthy as soon as Paperclip responds.
Compose deployments that override the image healthcheck should also set
`start_period: 6m`. The normal probe interval, timeout, and failure budget still
apply after startup. This grace does not release startup work holds or bypass
recovery checks.

## Local Adapter CLIs in Docker

The Docker image pre-installs these agent CLIs so their `*_local` adapters can run inside the container:

- `claude` (Anthropic Claude Code CLI) — `claude_local`
- `codex` (OpenAI Codex CLI) — `codex_local`
- `opencode` (OpenCode multi-provider CLI) — `opencode_local`
- `gemini` (Google Gemini CLI) — `gemini_local` (experimental)

Pass API keys to enable local adapter runs inside the container:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -e GEMINI_API_KEY=... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Each adapter reads its provider's standard credentials — for example `ANTHROPIC_API_KEY` (Claude), `OPENAI_API_KEY` (Codex), and `GEMINI_API_KEY` or `GOOGLE_API_KEY` (Gemini). OpenCode is multi-provider and uses whichever provider key you supply.

> **Gemini key restrictions:** Google requires Gemini API keys to be *restricted* to the Gemini API (scoped in the Google Cloud console); unrestricted keys are blocked and `gemini_local` runs will fail with an auth error. Create a restricted key, or authenticate with `gemini auth login` (OAuth) and persist `~/.gemini` via the data volume so the credential survives container restarts.

The image sets `GEMINI_SANDBOX=false` so the Gemini CLI does not try to launch its own (Docker-in-Docker) sandbox inside the container. The `gemini_local` adapter already passes `--sandbox=none` per run, so this env var only matters if you invoke `gemini` manually inside the container; override it if you have nested-container support and want CLI-level sandboxing.

Without API keys, the app runs normally — adapter environment checks will surface missing prerequisites.
