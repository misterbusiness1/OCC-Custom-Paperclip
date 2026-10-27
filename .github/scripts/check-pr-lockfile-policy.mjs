import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const QUALIFIED_BASELINE = Object.freeze({
  sourceCommit: 'cc4c664ed32d32f9beda9570a5a3f1823ebe4e26',
  imageId: 'sha256:4e05e4e26bd64a6727df986868ddc88dce2b1e631a8b98c5b5487f51e965b80f',
  previousLockSha256: 'ba6b70eae06944c2652284cac14ab2a5c038ed1a9a65733418dabeeebc7f65ea',
  generatedLockSha256: '9fd3ed3a0bb78170aef0e8834e5cf9e4788747b24e63afe2190e41773a3e3d20',
  packageManagerVersion: '9.15.4',
});

const LOCK_POLICY_ERROR = 'Do not commit pnpm-lock.yaml in pull requests. CI owns lockfile updates.';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function isDependencyInput(file) {
  const basename = path.posix.basename(file);
  if (file === 'pnpm-lock.yaml') return false;
  return new Set(['package.json', 'pnpm-workspace.yaml', 'pnpm-workspace.yml', '.npmrc',
    'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb',
    '.node-version', '.nvmrc', '.tool-versions']).has(basename)
    || /^\.?pnpmfile\.(?:cjs|mjs|js|ts)$/.test(basename)
    || file.split('/').includes('patches');
}

export function classifyLockfileChange(input) {
  if (!input.changedFiles.includes('pnpm-lock.yaml')) return { mode: 'unchanged', requireFrozenCheck: false };
  // Preserve the pre-existing CI-generated refresh and Dependabot policy.
  if (input.headBranch === 'chore/refresh-lockfile' || input.author === 'dependabot[bot]') {
    return { mode: 'existing-ci-owned-refresh', requireFrozenCheck: false };
  }
  const expected = QUALIFIED_BASELINE;
  if (input.baseSha !== expected.sourceCommit || input.mergeBase !== expected.sourceCommit
    || input.baseLockSha256 !== expected.previousLockSha256
    || input.headLockSha256 !== expected.generatedLockSha256) {
    throw new Error(LOCK_POLICY_ERROR);
  }
  const changedInputs = input.changedFiles.filter(isDependencyInput);
  if (changedInputs.length > 0) throw new Error('Verified baseline adoption cannot change dependency inputs: ' + changedInputs.join(', '));
  return { mode: 'verified-qualified-baseline-adoption', requireFrozenCheck: true };
}

export function assertPnpmVersion(version) {
  if (version.error || version.signal || version.status !== 0
    || version.stdout?.trim() !== QUALIFIED_BASELINE.packageManagerVersion) {
    throw new Error('Verified baseline adoption requires pnpm ' + QUALIFIED_BASELINE.packageManagerVersion);
  }
}

export function assertFrozenCheck(checked, before, after) {
  if (checked.error || checked.signal || checked.status !== 0) throw new Error('Frozen baseline consistency check failed');
  if (before !== QUALIFIED_BASELINE.generatedLockSha256 || after !== before) {
    throw new Error('Frozen consistency check changed lockfile bytes');
  }
}

export function verifyFrozenConsistency({ repoRoot, command = spawnSync }) {
  const lockfile = path.join(repoRoot, 'pnpm-lock.yaml');
  const info = lstatSync(lockfile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Canonical regular lockfile required');
  const before = sha256(readFileSync(lockfile));
  if (before !== QUALIFIED_BASELINE.generatedLockSha256) throw new Error('Working lockfile differs from the verified baseline');
  const options = { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 };
  const version = command('pnpm', ['--version'], options);
  assertPnpmVersion(version);
  // Offline + ignored scripts validates the frozen graph without lifecycle
  // execution, registry resolution drift, or dependency installation.
  const checked = command('pnpm', ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts', '--offline'], options);
  const afterInfo = lstatSync(lockfile);
  if (!afterInfo.isFile() || afterInfo.isSymbolicLink() || afterInfo.nlink !== 1) throw new Error('Frozen check replaced canonical lockfile');
  assertFrozenCheck(checked, before, sha256(readFileSync(lockfile)));
  return { packageManagerVersion: QUALIFIED_BASELINE.packageManagerVersion, lockSha256: before };
}

function git(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal || result.status !== 0) throw new Error('Lockfile policy Git inspection failed');
  return result.stdout;
}

export function changedFilesForRange(repoRoot, mergeBase, headSha) {
  // Include both sides of renames so a removed dependency input cannot hide
  // behind a destination whose name is unrelated to package configuration.
  return git(repoRoot, ['diff', '--no-renames', '--name-only', '-z', mergeBase, headSha]).split('\0').filter(Boolean);
}

export function main(env = process.env, repoRoot = process.cwd()) {
  if (!/^[0-9a-f]{40}$/.test(env.BASE_SHA ?? '') || !/^[0-9a-f]{40}$/.test(env.HEAD_SHA ?? '')) {
    throw new Error('Lockfile policy requires immutable base and head commits');
  }
  const mergeBase = git(repoRoot, ['merge-base', env.BASE_SHA, env.HEAD_SHA]).trim();
  const changedFiles = changedFilesForRange(repoRoot, mergeBase, env.HEAD_SHA);
  const changed = changedFiles.includes('pnpm-lock.yaml');
  const result = classifyLockfileChange({ changedFiles, mergeBase, baseSha: env.BASE_SHA,
    baseLockSha256: changed ? sha256(git(repoRoot, ['show', mergeBase + ':pnpm-lock.yaml'])) : null,
    headLockSha256: changed ? sha256(git(repoRoot, ['show', env.HEAD_SHA + ':pnpm-lock.yaml'])) : null,
    headBranch: env.HEAD_BRANCH, author: env.PR_AUTHOR });
  const verification = result.requireFrozenCheck ? verifyFrozenConsistency({ repoRoot }) : null;
  console.log(JSON.stringify({ ...result, verification }));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
