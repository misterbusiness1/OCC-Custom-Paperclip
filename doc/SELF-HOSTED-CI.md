# Self-hosted CI

Two ways to keep the pull request checks running when GitHub-hosted runners
are unavailable: Actions minutes run out, a billing refusal blocks jobs (see
`scripts/operations/actions-billing-refusal/`), or the hosted runners are
degraded.

1. **Local CI runner (recommended).** `pnpm ci:local` runs the `pr.yml` gates on
   a maintainer's machine, with no GitHub Actions involved. Use it for your own
   branches, and for other people's branches only after you have reviewed the
   code.
2. **Self-hosted Actions runners, for the verification workflows only.** One
   repository variable moves `pr.yml` and `release-verify.yml` onto runners you
   operate. This repository is public, so those runners will run code from
   strangers. Only use ephemeral runners set up as described in section 2.

## 1. Local CI runner (`pnpm ci:local`)

```sh
# All pr.yml verify gates, against origin/master
pnpm ci:local

# Also run the e2e suite (needs Chrome) and the canary release dry run
pnpm ci:local --with-e2e --with-canary

# Run specific gates
pnpm ci:local --gates policy,typecheck,build

# Post the results to the PR as informational commit statuses (needs `gh auth login`)
pnpm ci:local --report --keep-going

# Show what would run, without running it
pnpm ci:local --dry-run
```

`pnpm ci:local -- --flag` also works. The literal `--` that pnpm passes through
is ignored.

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
| `e2e` (opt-in) | `e2e` shards |
| `canary` (opt-in) | `Canary Dry Run` |

`scripts/__tests__/run-local-ci.test.mjs` runs in the `policy` job. It fails when
`pr.yml` gains a job or a `node`/`pnpm`/`./scripts/` command that the local gates
do not run.

### What it tests

- **The working tree, not the merge with the base branch.** That means HEAD
  plus any uncommitted changes. Pull request CI tests the PR merged into its
  base branch, so rebase onto `origin/master` first if master has moved.
- **The canary gate uses committed HEAD only.** It clones HEAD into a temporary
  directory under `TMPDIR` and checks out a branch named `master` there,
  because `release.sh` refuses to run from any other branch. It commits the
  qualified lockfile, as `pr.yml` does, and then runs
  `./scripts/release.sh canary --skip-verify --dry-run`. That script fetches and
  prunes the clone's own remote (your checkout), so none of your branches,
  tags or remote-tracking refs change. It needs network access to the npm
  registry and takes several minutes.
- **Test and e2e gates run with a cleaned environment.** `DATABASE_URL`,
  `DATABASE_MIGRATION_URL` and every `PAPERCLIP_*` variable are removed. The
  server and `onboard` would otherwise prefer an exported `DATABASE_URL` over
  embedded Postgres. The e2e gate sets `PAPERCLIP_E2E_SKIP_LLM=true` and
  `PAPERCLIP_PLAYWRIGHT_CHANNEL` (default `chrome`). It also passes through
  `PAPERCLIP_E2E_PORT`, because the fixed default port 3199 collides when two
  e2e runs share a host. `tests/e2e/playwright.config.ts` boots the server in
  its own temporary `PAPERCLIP_HOME`, so your `~/.paperclip` is not used.
- **Every other environment variable is visible to the code under test,**
  including `gh` logins and cloud credentials. Treat running `pnpm ci:local` on
  a branch like running that branch's code yourself.

The working tree is left as it was. A lockfile regenerated for the run is
restored, and the canary clone is deleted. This also happens on Ctrl-C or
SIGTERM: the runner then exits with 130 or 143, and a second Ctrl-C skips
waiting for the current command. `--dry-run` creates nothing.

### Reporting to pull requests (`--report`)

`--report` posts commit statuses on HEAD:

- `local-ci/<gate>` for every selected gate. Each starts as `pending`, then
  becomes `success` or `failure`, or `error` if the gate never ran or the run
  was interrupted.
- `local-ci/verify`, the aggregate. It is only posted when every default gate
  was selected, so `--gates policy --report` cannot produce a green
  `local-ci/verify`.

The runner refuses `--report` when the working tree has uncommitted or
untracked changes, because those results would be credited to a commit that
does not contain them. Every description starts with `Informational,
self-reported`.

These statuses are a convenience for reviewers, not evidence. Anyone with
write access to the repository, or any token with commit-status permission,
can post any context with any state without running anything. **Do not make
`local-ci/*` a required status check.** If a merge has to be gated while
Actions is down, the reviewer runs `pnpm ci:local` on the PR head themselves.

## 2. Self-hosted Actions runners (verification workflows only)

### Read this first: what a fork can do

- For `pull_request` events, GitHub runs the workflow files from the PR's
  merge commit. **The author of a fork PR controls the workflow YAML.** They
  can set `runs-on` to your self-hosted labels and run any code on your
  runner. The fork check in the `runs-on` expression only keeps unmodified
  workflows on hosted runners. It is not a security boundary.
- The only control before fork code runs is workflow approval, and GitHub's
  default for public repositories only asks for approval from first-time
  contributors.
- GitHub's guidance is not to use self-hosted runners with public
  repositories, because forks can run dangerous code on them
  ([self-hosted runner security](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#self-hosted-runner-security)).
  This repository belongs to a personal account, so runner groups are not
  available to limit which workflows can target a runner.

Treat every self-hosted runner attached to this repository as executing
untrusted code. If you cannot meet the requirements below, use `pnpm ci:local`
instead.

### Runner requirements (mandatory)

1. **Ephemeral or just-in-time runners only.** Each runner takes exactly one
   job and is then destroyed. Register it with `./config.sh --ephemeral`, or use
   a just-in-time config (`POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`),
   or use an autoscaler that creates ephemeral runners. Start every runner
   from a clean image on a new VM or container, and throw the VM or container
   away after its job. Never install a persistent runner as a service. A job
   can leave anything behind, for example a replaced Node binary in
   `$RUNNER_TOOL_CACHE` that `actions/setup-node` reuses, a poisoned pnpm store,
   or a background process. The next job would run it.
2. **Disposable hosts that hold no secrets or credentials.** That rules out
   cloud credentials, SSH keys, `gh` or npm logins, kubeconfigs, a shared Docker
   socket, and a real `~/.paperclip` instance. Keep the token that registers
   runners outside the runner VM.
3. **No access to internal networks.** Allow outbound internet only: GitHub,
   the npm registry and the Chrome download host if your image needs it. Block
   your LAN, other machines and cloud metadata endpoints such as
   `169.254.169.254`.
4. **Not shared with anything else.** The runners serve only this repository's
   verification jobs. Do not register them with other repositories, and do not
   use the hosts for other work.
5. **Tooling:** a non-root user (embedded Postgres refuses to start as root,
   and the DB-backed tests then skip), Node.js 24 with corepack, git, and
   Google Chrome for the e2e shards (`google-chrome --version` must work). Give
   each runner at least 8 GB RAM and 20 GB of free disk. Docker is not needed,
   because the Docker workflows stay on hosted runners.
6. **One job per network namespace.** The e2e shards use the fixed port 3199.
   One job per VM or container avoids collisions. Do not run several runners
   with host networking on one machine.

### Repository settings

1. Under **Settings → Actions → General → Approval for running fork pull
   request workflows from contributors**, select **Require approval for all
   external contributors**. Do not rely on the default.
2. Before approving a fork's workflow run, read the PR's changes under
   `.github/`, plus everything the jobs execute: `package.json` scripts,
   `scripts/`, test setup files and new dependencies. Approving runs whatever
   the PR contains on your runner.
3. Keep the public-repository defaults that give fork PRs no secrets and a
   read-only token.

### What switches, and what never does

The `runs-on` of every job in `pr.yml` and `release-verify.yml` reads the
repository variable `PAPERCLIP_CI_RUNS_ON`. Release verification is called by
`release.yml` for master pushes and stable releases. These workflows use no
secrets, are not `pull_request_target`, and run with a read-only
`GITHUB_TOKEN`. `pr.yml` pins `permissions: contents: read`, and every
`release-verify.yml` job declares `contents: read`.

Every other workflow keeps its literal GitHub-hosted label and ignores the
variable, because it holds credentials or needs the hosted image:

| Workflow | Why it stays hosted |
| --- | --- |
| `docker.yml`, `overlay-image.yml` | `packages: write`, pushes images |
| `agent-runtime-images.yml` | `packages: write` and `id-token: write` (cosign keyless signing) |
| `release.yml` publish and preview jobs | `contents: write`, `id-token: write`; npm trusted publishing only works on GitHub-hosted runners |
| `refresh-lockfile.yml` | `contents: write`, `pull-requests: write` |
| `commitperclip-review.yml` | `pull_request_target` with repository secrets |
| `e2e.yml` | `ANTHROPIC_API_KEY` |
| `release-smoke.yml` | runs Docker containers |
| `storybook-visual.yml` | `npx playwright install --with-deps` needs sudo |

Do not add the variable to these workflows. A runner that ran a PR job must
never later run a job holding credentials.

### Turn it on

1. Build the runner image and the automation that creates one ephemeral
   runner per job (see the requirements above). Give the runners a dedicated
   label, for example `paperclip-ephemeral`, so jobs only go to machines
   registered for this purpose.
2. Under **Settings → Secrets and variables → Actions → Variables**, create the
   repository variable `PAPERCLIP_CI_RUNS_ON`. Its value is JSON: one label as a
   JSON string (`"paperclip-ephemeral"`) or an array of labels that a runner
   must all have (`["self-hosted","linux","x64","paperclip-ephemeral"]`). A bare
   word without quotes is not valid JSON.
3. Open or update a PR from a branch in this repository and check that its
   jobs ran on your runner. The required checks keep their names (`verify`,
   `e2e`), whichever runner runs them.

### Failure modes

- **Invalid JSON** makes `fromJSON` fail while evaluating `runs-on`. Every job
  that reads the variable then fails to start with an expression error. This
  affects all PRs from this repository and release verification at the same
  time.
- **Labels that no online runner matches** do not fall back to hosted runners.
  The jobs stay queued for up to 24 hours and then fail, and release
  verification, which the publish jobs wait on, stays queued with them.
- **Not everything moves.** Fork PRs with unmodified workflows and every
  workflow in the table above still need GitHub-hosted runners, so a
  GitHub-side outage still affects them.

### Turn it off

Delete the variable (**Settings → Secrets and variables → Actions → Variables**,
or `gh variable delete PAPERCLIP_CI_RUNS_ON`). Jobs started afterwards use
`ubuntu-latest` again. Cancel runs that are still queued for the self-hosted
labels, then re-run them. If a re-run still waits for the old labels, push a
new commit to start a fresh run.
