# Self-hosted CI

Every check in `.github/workflows/` can run without GitHub-hosted runners. Use
this when Actions minutes are exhausted, a billing refusal blocks jobs (see
`scripts/operations/actions-billing-refusal/`), hosted runners are degraded, or
you simply want results faster on your own hardware.

There are two independent pieces:

1. **Self-hosted Actions runners.** The workflows stay on GitHub, but jobs run on
   machines you control. One repository variable switches every job over.
2. **Local CI runner.** `pnpm ci:local` runs the same gates as `pr.yml` on any
   checkout, with no GitHub Actions involved. It can post each result to the PR
   as a commit status.

## 1. Self-hosted Actions runners

Every job's `runs-on` reads the repository variable `PAPERCLIP_CI_RUNS_ON`:

- **Unset (default):** each job uses its GitHub-hosted label (`ubuntu-latest`,
  or `ubuntu-22.04` for agent runtime images). Nothing changes.
- **Set:** jobs run on the runner labels in the variable, written as JSON. For
  example, `["self-hosted","linux","x64"]` or `"self-hosted"`.

Pull requests from forks always stay on GitHub-hosted runners, whatever the
variable says. This applies to both `pull_request` and `pull_request_target`.
The repository is public, and fork code must never execute on your machines.

### Set it up

1. Register a runner: **Settings → Actions → Runners → New self-hosted runner**.
   Follow the Linux instructions on a machine you control, then install it as a
   service (`sudo ./svc.sh install && sudo ./svc.sh start`).
2. Give the runner what the hosted image provided:
   - Node.js 24 with corepack (`corepack enable`)
   - git, `gh`, `jq`, `curl`
   - Google Chrome, for the e2e lanes (`google-chrome --version` must work)
   - Docker with buildx, for the `docker`, `overlay-image` and
     `agent-runtime-images` workflows
   - Go, only for `tools/agent-shim` image builds
   - At least 8 GB RAM and 20 GB free disk. The server suites run embedded
     Postgres.
   - Run the runner as a **non-root** user. Embedded Postgres refuses to start as
     root, and the DB-backed tests then skip.
3. Point CI at it: **Settings → Secrets and variables → Actions → Variables →
   New repository variable**. Set `PAPERCLIP_CI_RUNS_ON` to
   `["self-hosted","linux","x64"]`.
4. Also under **Settings → Actions → General**, keep "Require approval for all
   outside collaborators" enabled.

To go back to hosted runners, delete the variable.

## 2. Local CI runner (`pnpm ci:local`)

```sh
# All pr.yml verify gates against origin/master
pnpm ci:local

# Also run the e2e suite (needs Chrome) and the canary release dry run
pnpm ci:local -- --with-e2e --with-canary

# Run specific gates
pnpm ci:local -- --gates policy,typecheck,build

# Post each gate to the PR as a commit status on HEAD (needs `gh auth login`)
pnpm ci:local -- --report --keep-going

# Show what would run without running it
pnpm ci:local -- --dry-run
```

| Gate | Same as `pr.yml` job/step |
| --- | --- |
| `policy` | `policy`: lockfile-edit block, Docker deps stage, no-git-push, workflow wiring tests, release manifest/bootstrap checks |
| `install` | lockfile qualification + `pnpm install --frozen-lockfile` |
| `typecheck` | `Typecheck + Release Registry` |
| `audit` | `Dependency Audit` |
| `typesafe-skill` | `TypeSafe skill-suggestion standalone` |
| `general-tests` | `General tests` (server shards, workspaces-a, workspaces-b) |
| `serialized-tests` | `Verify serialized server suites` |
| `build` | `Build` |
| `e2e` (opt-in) | `e2e` shards, using an isolated temporary `HOME` |
| `canary` (opt-in) | `Canary Dry Run`, in a throwaway git worktree |

The working tree is left as it was. If a lockfile is regenerated for the run
(as the policy job does in CI), the original is restored afterwards.

### Reporting to pull requests

With `--report`, the runner posts these commit statuses on `HEAD`:

- `local-ci/<gate>` for every gate: `pending` at start, then `success`,
  `failure`, or `error` if the gate never ran
- `local-ci/verify` as the aggregate

To make local results gate merges while Actions is unavailable, add
`local-ci/verify` as a required status check in the branch protection rule for
`master`. Remove it again once hosted CI is healthy, if you prefer Actions to be
the only gate.
