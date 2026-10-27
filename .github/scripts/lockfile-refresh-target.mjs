import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function resolveTarget({ event, baseRef, expectedSha, eventSha, repository }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  const base = event === 'push' ? 'master' : baseRef;
  const sha = event === 'push' ? eventSha : expectedSha;
  if (!base || base === 'chore/refresh-lockfile' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base)
      || base.trim() !== base || base.includes('..') || base.includes('//') || base.endsWith('/')
      || base.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new Error('Invalid explicit base branch');
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Exact expected source SHA required');
  if (!['push', 'workflow_dispatch'].includes(event)) throw new Error('Unsupported event');
  return { baseRef: base, expectedSha: sha, repository };
}
export function assertTargetState(target, { actualSha, branchExists, branchSha, openPullRequests }, ownedRefreshSha) {
  if (actualSha !== target.expectedSha) throw new Error('Target branch moved; request a fresh pinned refresh');
  if (ownedRefreshSha !== undefined && !/^[a-f0-9]{40}$/.test(ownedRefreshSha)) throw new Error('Invalid owned refresh SHA');
  if (openPullRequests.length !== 0 || (ownedRefreshSha === undefined ? branchExists : !branchExists || branchSha !== ownedRefreshSha)) {
    throw new Error('Existing refresh branch or PR must be resolved first; never overwrite it');
  }
}
function gh(args) { return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim(); }
export function verifyRemote(target, ownedRefreshSha) {
  const prefix = `repos/${target.repository}`;
  const actualSha = JSON.parse(gh(['api', `${prefix}/git/ref/heads/${target.baseRef}`])).object.sha;
  const refs = JSON.parse(gh(['api', `${prefix}/git/matching-refs/heads/chore/refresh-lockfile`]));
  const prs = JSON.parse(gh(['api', `${prefix}/pulls?state=open&head=${target.repository.split('/')[0]}:chore/refresh-lockfile&per_page=100`]));
  const branch = refs.find(r => r.ref === 'refs/heads/chore/refresh-lockfile');
  assertTargetState(target, { actualSha, branchExists: Boolean(branch), branchSha: branch?.object?.sha, openPullRequests: prs }, ownedRefreshSha);
  return target;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = resolveTarget({ event: process.env.REFRESH_EVENT, baseRef: process.env.REFRESH_BASE_REF,
    expectedSha: process.env.REFRESH_EXPECTED_SHA, eventSha: process.env.REFRESH_EVENT_SHA, repository: process.env.GITHUB_REPOSITORY });
  console.log(JSON.stringify(verifyRemote(target, process.env.OWNED_REFRESH_SHA)));
}
