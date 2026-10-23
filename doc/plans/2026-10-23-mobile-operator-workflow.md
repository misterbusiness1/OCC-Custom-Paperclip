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
