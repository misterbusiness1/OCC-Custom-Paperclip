# Oxford production source provenance

Every future Oxford production candidate must be available from GitHub **before
its first drain or deployment mutation**. Install the reviewed entrypoint from a
clean checkout whose HEAD is the approved full commit SHA:

```sh
python3 /path/to/reviewed-checkout/scripts/production/install.py \
  --source /path/to/reviewed-checkout --source-commit <full-reviewed-commit-sha>
```

The installer only writes the local launcher, pinned helper and adoption receipt;
it never invokes the deployment guard. It verifies the helper bytes against the
chosen Git commit, refuses dirty/hidden-index source, and refuses to overwrite an
unrelated or modified existing command. It installs:

- `~/.local/bin/paperclip-production-deploy`: canonical operator command.
- `~/.local/share/paperclip/production-launcher/<helper-sha256>/deploy.py`: immutable selected helper.
- `~/.local/share/paperclip/production-launcher-adoption.json`: source commit, helper hash,
  launcher hash and installation time. No credentials are recorded.

The command verifies the pinned helper hash and executes those exact verified bytes
on every invocation. Keep `~/.local/bin` on the operator PATH. Use this canonical
command for each future release phase:

```sh
~/.local/bin/paperclip-production-deploy \
  --manifest /absolute/path/to/release-provenance.json
~/.local/bin/paperclip-production-deploy \
  --manifest /absolute/path/to/release-provenance.json --phase prepare --execute
# Then invoke each existing phased guard operation separately through this entrypoint.
# For example: --phase drain --execute, --phase apply --execute, --phase release --execute.
```

This is a gate in front of the existing phased Oxford guard, not a replacement for
its runtime, drain, startup-barrier, image-preservation, rollback or native GitHub
review checks. The wrapper never invokes Docker itself and never chains phases.
For promotion phases, it fetches the advertised GitHub ref into a temporary bare repository on every
invocation, verifies the exact commit and tree against the candidate, verifies
that the source checkout is clean and has no `assume-unchanged` or
`skip-worktree` index flags hiding tracked files, and binds passing test and approved review
receipts to the same source and immutable image. Missing/unreachable repositories,
refs, stale receipts, changed files, dirty source and source/image mismatches stop
before invoking the guard. Read-only preflight does not invoke the guard.

Use a dedicated clean checkout for source proof. Keep build outputs and generated
lockfiles outside that checkout: the repository's CI-owned lockfile policy is
unchanged. An approved native overlay still requires its existing full artifact
preservation proof; merely proving a Git commit does not prove the image contents.

## Release manifest

All paths must be absolute. Compute SHA-256 hashes after the inputs are final.
Store the manifest and release evidence outside the clean source checkout.

```json
{
  "schema": "paperclip.production-provenance.v1",
  "githubRepository": "https://github.com/misterbusiness1/OCC-Custom-Paperclip.git",
  "githubRef": "refs/heads/release/qualified-source-<commit>",
  "candidateFrame": {"path": "/release/candidate-frame.json", "sha256": "<sha256>"},
  "testsReceipt": {"path": "/release/tests.json", "sha256": "<sha256>"},
  "reviewReceipt": {"path": "/release/review.json", "sha256": "<sha256>"},
  "guard": {"path": "/release/guard.py", "sha256": "<sha256>"}
}
```

The candidate frame is the existing phased guard's frame, including:
`sourceRepository`, `candidateSourceCommit`, `candidateSourceTree`, and
`candidateImageId`. Both receipts must include exactly matching `sourceCommit`,
`sourceTree`, and `imageId`, plus `passed: true`. The review receipt must also have
`approved: true`. Keep the detailed commands, results and reviewer evidence in
those receipts; the wrapper does not prescribe or replace the test matrix.

Receipts and manifest are trusted operator inputs, not signed attestations. Hashes
prevent changes after selection; they do not authenticate their author or establish
that a claimed review happened. The approved, hash-pinned deployment guard remains
responsible for checking actual GitHub CI and native approval evidence. Do not point
the manifest at an unreviewed helper that omits those checks. Never place credentials
in this manifest. Use the normal Git credential helper for repository access.

## Bind forward phases to the prepared release

For every forward phase after `prepare`, the launcher reads `preparation.json`
from the selected guard's resolved directory. The reviewed guard must itself consume
that exact file. The supported receipt schema is
`paperclip.production.preparation.v1` (the frozen native guard uses
`paperclip.codex-native.preparation.v1`). Its `helperSha256` must match the selected
guard; `framePath` and `frameSha256` must identify the exact manifest candidate frame.
Missing, unknown, changed or different-release preparation stops before dispatch.
The launcher checks receipt bytes again immediately before dispatch. A different
candidate requires its own preparation through the normal guard lifecycle; do not
rewrite frozen receipts to force a match. Guards using another preparation contract
require a reviewed integration before this launcher can dispatch their forward phases.
`prepare` receives the selected frame directly and does not require prior preparation.
The offline rollback exception below retains the guard's own recovery authority.

## Adopt at the operator boundary

The current historical guard and its frozen qualification evidence live outside
Git under the release directory. Preserve them unchanged. Promote the command above
as the **canonical production launcher** in the operator's maintained deployment
policy/launcher, and route **every** future phase (including rollback phases)
through it. Before promotion, review this entrypoint and run the installer at the approved
repository commit. Record its adoption receipt in the release handoff. To update,
repeat installation from the next clean reviewed commit; the installer only
replaces a command that still matches its previous adoption receipt. Old helper
copies are retained for inspection. To reverse adoption, remove the managed command
only after verifying it against the receipt and restore the previously approved
operator launcher; do not remove a command modified independently by another owner.

The wrapper cannot prevent an administrator directly running the historical guard
or Docker. Therefore deployment provenance is enforced only for the adopted launch
path, and installation of the canonical launcher must be recorded separately.
Adding this file alone does not retroactively qualify current production or imply
that the historical direct-invocation path was changed. Retired historical guards
must not become future deployment entrypoints. A failed phase must be reconciled
using the existing guard's receipts before any retry; do not replay mutations.

## Emergency rollback remains offline

`rollback_drain`, `rollback_restore`, `rollback_qualify`, and `rollback_release`
only require an unchanged hash-pinned guard and explicit `--execute`. They dispatch
to the existing guard, whose frozen verification, operator authorization and
rollback-image checks remain mandatory. They deliberately do **not** fetch GitHub,
read the new candidate, or depend on its test/review receipts. An unavailable GitHub
repository or incomplete candidate cannot prevent restoration of the already
verified previous image. This exception authorizes restoration only; `apply` and
all other promotion phases still require the full source gate.

## Offline verification

```sh
python3 -m unittest discover -s scripts/production -p 'test_*.py' -v
```

Tests use local bare remotes and a fake guard. The public command accepts only
credential-free GitHub HTTPS URLs; local remote support is available only to the
internal test function, not as an operator flag. No test contacts GitHub, Docker,
Paperclip, or a model provider.
