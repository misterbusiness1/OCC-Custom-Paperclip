import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTarget, assertTargetState } from '../lockfile-refresh-target.mjs';
const sha = 'a'.repeat(40);
const input = { event: 'workflow_dispatch', baseRef: 'release/auth-177', expectedSha: sha, repository: 'owner/repo' };
test('dispatch pins explicit release base and source', () => assert.equal(resolveTarget(input).baseRef, input.baseRef));
test('push retains master with immutable event SHA', () => assert.deepEqual(resolveTarget({ ...input, event: 'push', eventSha: sha }), { baseRef: 'master', expectedSha: sha, repository: 'owner/repo' }));
test('reject absent, option-like, traversal, refresh and malformed refs or SHAs', () => {
  for (const baseRef of ['', '-evil', '../master', 'a//b', 'chore/refresh-lockfile', 'x.lock', 'a/', 'release\n', 'a/.hidden', 'a/end.']) assert.throws(() => resolveTarget({ ...input, baseRef }));
  for (const expectedSha of ['', 'master', 'a'.repeat(39)]) assert.throws(() => resolveTarget({ ...input, expectedSha }));
});
test('no moved target or occupied branch/PR may be overwritten', () => {
  const t = resolveTarget(input); const clean = { actualSha: sha, branchExists: false, openPullRequests: [] };
  assert.doesNotThrow(() => assertTargetState(t, clean));
  assert.throws(() => assertTargetState(t, { ...clean, actualSha: 'b'.repeat(40) }));
  assert.throws(() => assertTargetState(t, { ...clean, branchExists: true }));
  assert.throws(() => assertTargetState(t, { ...clean, openPullRequests: [{ base: 'unrelated' }] }));
});

test('before PR creation requires exact owned branch SHA, no PR, and unchanged base', () => {
  const t = resolveTarget(input), owned = 'b'.repeat(40);
  const state = { actualSha: sha, branchExists: true, branchSha: owned, openPullRequests: [] };
  assert.doesNotThrow(() => assertTargetState(t, state, owned));
  for (const delta of [{ branchExists: false }, { branchSha: sha }, { actualSha: owned }, { openPullRequests: [{ base: { ref: 'different-base' } }] }]) {
    assert.throws(() => assertTargetState(t, { ...state, ...delta }, owned));
  }
});
