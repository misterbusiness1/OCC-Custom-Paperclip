# Mobile operator workflow

Release base: production PR #205, 8b20bfba4efc29d82148ad372a7cb34970695550. Revalidate release lineage before merge/deploy.

## Required outcomes

1. Email approvals show an expandable original incoming request separately from the outgoing draft, with source metadata and an explicit unavailable state. Never infer incoming content from outgoing text. Preserve company access and exact-content decision checks.
2. Mobile task navigation exposes assigned, blocked, overdue and review work using existing filters, without dropping company context.
3. Agent health exposes failures and recent heartbeats with safe retry controls; no automatic retry or concurrent duplicate run.
4. Responsive navigation, touch targets, readable input sizes and safe-area layout work at narrow portrait and landscape widths without hiding actions or content.
5. Approval/retry actions prevent duplicate submission and report actual success/error inline.
6. Installation uses the existing web manifest and one shared app. Keep authenticated data out of offline caches; do not queue approvals or retries offline.

## Verification and rollout

For each outcome, inspect existing behavior, add missing behavior and run focused tests. Existing functionality must be verified, not rewritten for appearance. Then run repository typecheck, tests, build and token gates, browser tests for mobile and desktop, and an adversarial standards/spec/security review of the final diff. Fix findings and rerun affected and final checks. Stage the exact candidate and verify read-only authenticated workflows with synthetic mutation fixtures. Production deployment is authorized only after these checks pass; verify deployed image/source and health and retain a verified rollback.

Real-device Safari/Android behavior (keyboard, standalone safe areas, touch and installation) requires hardware evidence; emulation alone does not prove it. Record any missing evidence honestly and do not label the full release green prematurely.

## Progress

- Isolated worktree created from verified deployed source.
- Existing bottom navigation, source-request rendering, version-conflict handling and touch rules identified. Need behavior/data-path coverage before completion.
- Existing manifest opens in browser mode, so standalone installation behavior is missing.

- Email disclosure renders literal source text with provenance; three focused security/state tests passed. Actual two pending cards had no source; exact-version revision requests sent to their original requester, no approval or send. Submission skill now requires retrieved incoming text for replies.
- Agent roster now retains status, last heartbeat and live-run access on narrow screens; 73 email/agent/page regression checks passed.
- Task shortcuts use server-side filters; overdue means explicit scheduled follow-up, not task age. Five real PostgreSQL route tests passed, including pagination, terminal exclusion, malformed queries and cross-company access.
- Mobile navigation has an opaque semantic background and becomes inert while hidden. Keyboard-resizing viewport, coarse-pointer input sizes and standalone manifest are configured; design-token gates passed.
- Existing exact-run retry API is idempotent. Added synchronous tap guard and retained success state before navigation; final interaction tests still required.
- UI typecheck and production UI build passed after building workspace SDK. 51 PWA/update/approval-feedback/layout checks passed; offline-private-cache checks pending.
- Remote release branch advanced to PR #206 (201b5e4b8) during implementation. Rebase and repeat qualification before PR/deploy. Local lock normalization is test setup only; repository policy forbids committing it.

- Rebased onto verified remote release PR #206, 201b5e4b8611d5bd480626965ae4eb43c689b480. No conflicts.
- Repository-wide typecheck passed with the existing pinned Rust 1.97.1 toolchain. Production UI build passed.
- Four actual built-app browser checks passed: source disclosure and task/agent views at 390x844, 844x390 and 1280x900, plus exact-run rapid-tap refusal handling. Added coarse-touch target measurement for the final repeat.
- Adversarial self-inspection removed a newly introduced nested run link from the mobile agent row, centralized the overdue predicate, and ensured coarse-pointer summary targets meet the existing 44px floor. Follow-up tests are running.
- 47 selected private-cache/offline/task-view/agent tests passed. Five actual PostgreSQL filters tests passed. Broader agent run suite had 73 passes and one first-import timeout under concurrent Rust compilation; rerun without compilation contention is required.
- Full test suite and full build remain running. Independent review, staging and real-device evidence remain open. No production deployment has occurred.

## Review and security correction round

- Independent CQE review at ecdb72e640446061a779fd6e3f3b7ac0df3dd901 found a P1: persisted board mode overwrites parent task-view status restrictions in column queries. The existing assigned engineer is preparing the intersection fix with rendered regression evidence on a separate branch. Do not merge this candidate until integrated and re-reviewed.
- Actual GitHub required audit found GHSA-mrhx-c7xc-m3w5 in Zod. Updated direct v4 minimums and the shared v4 override to the fixed line (resolved 4.6.7). Updated Cursor SDK to 1.0.40, which supports Zod v4 as a peer and removes the vulnerable standalone v3 dependency, rather than forcing an incompatible major into the old SDK.
- Production audit on the normalized current graph: 0 high, 0 critical (2 low and 10 moderate remain). A bounded array/set/map regression failed three checks with the old dependency and passes all four checks after repair. No memory-exhaustion attack was run.
- 383 focused validator/Cursor/email checks passed after the dependency update. Full repository typecheck passed again. All 79 selected live-run and actual PostgreSQL route tests now pass: cold route imports moved into fixture setup, without changing request assertions or increasing timeouts.
- The obsolete pre-security full local test invocation was explicitly stopped after its graph became obsolete; it is not green evidence. Exact-head full CI must pass on the corrected graph.
- Four touch-mode built-app checks passed before this dependency correction; they must be repeated after final integration along with full build and final review.
- Source retrieval verified one real inbound email and one checkout note rather than an email. The original requester is instructed to attach both with truthful provenance, and incoming-source labels must not falsely call a checkout note an email.

## Exact dependency qualification round

- Final head6c8345b78 integrated the board-mode correction;59 focused tests, full build and four Chromium touch checks passed. IndependentCQE re-review found no new substantive blocker and passed159 focused checks. Final approval was correctly withheld pending release evidence.
- Required runner Vitest then caught the Claude installed-graph qualification still expecting Zod4.4.3. Updated the exact qualification and all direct/transitive v4 pins to4.6.7; broad ranges had resolved one Claude supplemental dependency to4.6.6 while the app used4.6.7. A fresh frozen install now aligns the graph. All71 installation-integrity checks pass, including the real installed Claude graph and added rejection assertions for old4.4.3 and unqualified future4.6.8. Version/descriptor checks remain strict.
- Firefox and WebKit passed all six real-API mobile/email/task/agent cases. The mocked retry fixture initially failed in WebKit because service-worker-owned traffic bypassed page.route and reached the real empty run list. Scoped serviceWorkers:block to that synthetic routed fixture only; both Firefox/WebKit retry repeats pass. Real-API cases retain service workers. Full final cross-browser repeat remains required.
- Canonical image build is queued behind the exact running backup invocation and80GiB admission/70GiB build reserve. No archive or rollback deletion, BuildKit pruning, staging mutation or production action. Source advance supersedes the queued prior-head build. Rebind build inputs to final head before proceeding.

### Task-view board scope repair (2026-10-25)

Both legacy and streamlined task boards intersect the collection's allowed
statuses with saved local statuses. The same intersection controls requests and
visible lanes. Saved controls can narrow a task view but cannot widen it.
Company, assignee, participant, workspace, project, search, overdue and pagination
constraints remain on the existing server requests. Column limits and abort
signals remain unchanged. Company and assignee checks also protect rendered rows.
Scoped boards wait for current query results rather than displaying parent rows
from a previous task view. Search changes do not reuse previous-query rows.

Regression commands (run from the repository root unless stated):

- From `ui/`: `pnpm exec vitest run src/components/IssuesList.board-scope.test.tsx src/components/IssuesList.test.tsx src/pages/Issues.test.tsx src/lib/operator-task-views.test.ts`
- From `server/`: `pnpm exec vitest run src/__tests__/issue-list-updatedsince-filter-routes.test.ts`
- `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/legacy-board-task-views.spec.ts`
- `pnpm check:token-gates`

Detection: a Blocked or In review board must never request another status column
or display its cards, including after search changes and persisted-layout reload.
A saved conflicting status must produce no lanes. Test both values of
`enableStreamlinedUi`; toggling that flag alone is not a rollback for this shared
repair. The Playwright command starts a disposable local Paperclip instance and
must not target shared staging or production.

Rollback: revert the repair PR through normal review and release gates. No data
migration, persistent format change, or new flag is required. Until a rollback or
repair is qualified, operators can switch affected task views to List mode as a
workaround. There is no new dedicated kill switch. This change does not qualify
staging, waive hardware checks, or authorize production deployment.

Local Chromium examples: [legacy Blocked board](../assets/legacy-board-task-views/legacy-blocked.png),
[legacy empty search](../assets/legacy-board-task-views/legacy-search-empty.png),
and [streamlined parity](../assets/legacy-board-task-views/streamlined-blocked.png).
These are synthetic disposable-local-fixture captures, not staging attestations.
