import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestOption } from '../src/args.js';

test('suggests the closest option for a typo', () => {
  const names = ['bucket', 'events-bucket', 'dry-run', 'json', 'help'];
  assert.equal(suggestOption('--event-bucket', names), '--events-bucket');
  assert.equal(suggestOption('--dryrun', names), '--dry-run');
  assert.equal(suggestOption('--jsn', names), '--json');
  assert.equal(suggestOption('--bucket=x', names), '--bucket');
  assert.equal(suggestOption('--xyz', names), null);
});
