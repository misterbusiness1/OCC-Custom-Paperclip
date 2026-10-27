import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { QUALIFIED_BASELINE as baseline, classifyLockfileChange, isDependencyInput,
  assertPnpmVersion, assertFrozenCheck, verifyFrozenConsistency, changedFilesForRange, main } from '../check-pr-lockfile-policy.mjs';

const qualified = () => ({ changedFiles: ['pnpm-lock.yaml', 'server/src/app.ts'],
  baseSha: baseline.sourceCommit, mergeBase: baseline.sourceCommit,
  baseLockSha256: baseline.previousLockSha256, headLockSha256: baseline.generatedLockSha256,
  headBranch: 'fix/audit-assurance-observability-20261026', author: 'maintainer' });
const success = { status: 0, signal: null, error: undefined, stdout: '9.15.4\n' };

test('ordinary source-only changes retain the unchanged policy path', () => {
  assert.deepEqual(classifyLockfileChange({ changedFiles: ['server/src/app.ts'] }), { mode: 'unchanged', requireFrozenCheck: false });
});
test('exact qualified baseline adoption still requires the frozen consistency proof', () => {
  assert.deepEqual(classifyLockfileChange(qualified()), { mode: 'verified-qualified-baseline-adoption', requireFrozenCheck: true });
});
for (const [name, value] of [['headBranch', 'chore/refresh-lockfile'], ['author', 'dependabot[bot]']]) {
  test('preserves existing CI-owned exemption for ' + name, () => {
    assert.deepEqual(classifyLockfileChange({ changedFiles: ['pnpm-lock.yaml', 'package.json'], [name]: value }),
      { mode: 'existing-ci-owned-refresh', requireFrozenCheck: false });
  });
}
for (const field of ['baseSha', 'mergeBase', 'baseLockSha256', 'headLockSha256']) {
  test('rejects baseline adoption with mismatched ' + field, () => {
    assert.throws(() => classifyLockfileChange({ ...qualified(), [field]: '0'.repeat(field.includes('Sha256') ? 64 : 40) }), /CI owns lockfile/);
  });
}
test('feature-branch names and human authors create no generic exemption', () => {
  for (const headBranch of ['release/audit-baseline-20261026', 'chore/refresh-lockfile-extra', 'fix/arbitrary']) {
    assert.throws(() => classifyLockfileChange({ ...qualified(), headBranch, headLockSha256: '0'.repeat(64) }), /CI owns lockfile/);
  }
});
test('rejects all dependency input changes, including workspace hooks and patches', () => {
  const inputs = ['package.json', 'packages/shared/package.json', 'pnpm-workspace.yaml', 'nested/pnpm-workspace.yml',
    '.npmrc', 'nested/.npmrc', '.pnpmfile.cjs', 'pnpmfile.mjs', 'nested/.pnpmfile.js',
    'patches/runtime.patch', 'nested/patches/runtime.patch', 'plugin/pnpm-lock.yaml',
    'package-lock.json', 'npm-shrinkwrap.json', 'nested/yarn.lock', 'bun.lockb', '.node-version', '.nvmrc', '.tool-versions'];
  for (const input of inputs) {
    assert.equal(isDependencyInput(input), true, input);
    assert.throws(() => classifyLockfileChange({ ...qualified(), changedFiles: [...qualified().changedFiles, input] }), /cannot change dependency inputs/, input);
  }
  assert.equal(isDependencyInput('pnpm-lock.yaml'), false);
  assert.equal(isDependencyInput('server/src/patches.ts'), false);
});
test('requires exact pinned package manager version', () => {
  assert.doesNotThrow(() => assertPnpmVersion(success));
  for (const result of [{ ...success, stdout: '9.15.5' }, { ...success, stdout: '' },
    { ...success, status: 1 }, { ...success, signal: 'SIGTERM' }, { ...success, error: new Error('spawn') }]) {
    assert.throws(() => assertPnpmVersion(result), /pnpm 9\.15\.4/);
  }
});
test('frozen command success and unchanged exact bytes are both required', () => {
  assert.doesNotThrow(() => assertFrozenCheck(success, baseline.generatedLockSha256, baseline.generatedLockSha256));
  for (const result of [{ ...success, status: 1 }, { ...success, signal: 'SIGTERM' }, { ...success, error: new Error('spawn') }]) {
    assert.throws(() => assertFrozenCheck(result, baseline.generatedLockSha256, baseline.generatedLockSha256), /consistency check failed/);
  }
  assert.throws(() => assertFrozenCheck(success, baseline.generatedLockSha256, '0'.repeat(64)), /changed lockfile bytes/);
  assert.throws(() => assertFrozenCheck(success, '0'.repeat(64), '0'.repeat(64)), /changed lockfile bytes/);
});
for (const kind of ['symlink', 'hardlink', 'wrong-bytes']) {
  test('rejects ' + kind + ' working lock before running commands', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'paperclip-lock-policy-'));
    try {
      const lock = path.join(root, 'pnpm-lock.yaml'); const other = path.join(root, 'other');
      writeFileSync(other, 'synthetic fixture');
      if (kind === 'symlink') symlinkSync(other, lock);
      else if (kind === 'hardlink') linkSync(other, lock);
      else writeFileSync(lock, 'synthetic fixture');
      let commands = 0;
      assert.throws(() => verifyFrozenConsistency({ repoRoot: root, command: () => { commands++; return success; } }),
        /Canonical regular lockfile|differs from the verified baseline/);
      assert.equal(commands, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test('CLI requires immutable commits before invoking Git', () => {
  for (const env of [{}, { BASE_SHA: 'main', HEAD_SHA: baseline.sourceCommit },
    { BASE_SHA: baseline.sourceCommit, HEAD_SHA: 'HEAD' }]) {
    assert.throws(() => main(env, '/nonexistent'), /immutable base and head commits/);
  }
});

test('renaming a dependency input cannot conceal its removal', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'paperclip-lock-policy-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q');
    writeFileSync(path.join(root, 'package.json'), '{"name":"synthetic"}\n');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'before');
    const before = git('rev-parse', 'HEAD');
    git('mv', 'package.json', 'README.md');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'rename');
    const changed = changedFilesForRange(root, before, git('rev-parse', 'HEAD'));
    assert.deepEqual(changed.sort(), ['README.md', 'package.json']);
    assert.throws(() => classifyLockfileChange({ ...qualified(), changedFiles: ['pnpm-lock.yaml', ...changed] }), /cannot change dependency inputs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
