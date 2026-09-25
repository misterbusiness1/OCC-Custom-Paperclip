import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationOrder } from '../check-pr-migration-order.mjs';

const migration = (name) => `packages/db/src/migrations/${name}.sql`;

test('passes when a PR has no new migrations', () => {
  const result = checkMigrationOrder([migration('0230_on_master')], []);

  assert.equal(result.passed, true);
});

test('passes when every PR migration follows the target branch', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0231_first_in_pr'), migration('0232_second_in_pr')],
  );

  assert.equal(result.passed, true);
});

test('fails with renumbering guidance when a PR reuses the target branch number', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0230_from_stale_branch')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through .*0230_on_master\.sql/);
  assert.match(result.message, /renumber this PR's migrations starting at 0231/);
  assert.match(result.message, /meta\/_journal\.json/);
});

test('fails when a PR inserts a migration before the target branch tip', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0229_from_stale_branch'), migration('0231_valid_but_after_stale')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /0229_from_stale_branch\.sql/);
  assert.doesNotMatch(result.message, /- packages\/db\/src\/migrations\/0231_valid_but_after_stale\.sql/);
});

test('fork: compares upstream-numbered migrations only against upstream-numbered base migrations', () => {
  const result = checkMigrationOrder(
    [migration('0279_upstream_tip'), migration('9006_fork_tip')],
    [migration('0280_next_upstream'), migration('9007_next_fork')],
  );

  assert.equal(result.passed, true);
});

test('fork: still rejects collisions inside the upstream range and the fork block', () => {
  const upstream = checkMigrationOrder(
    [migration('0279_upstream_tip'), migration('9006_fork_tip')],
    [migration('0279_stale_upstream')],
  );
  assert.equal(upstream.passed, false);
  assert.match(upstream.message, /renumber this PR's migrations starting at 0280/);

  const fork = checkMigrationOrder(
    [migration('0279_upstream_tip'), migration('9006_fork_tip')],
    [migration('9006_stale_fork')],
  );
  assert.equal(fork.passed, false);
  assert.match(fork.message, /already contains migrations through .*9006_fork_tip\.sql/);
  assert.match(fork.message, /renumber this PR's migrations starting at 9007/);
});
