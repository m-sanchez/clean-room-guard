import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  UsageError,
  assertPolicyOutside,
  parsePolicy,
  report,
  scan,
  scanText
} from '../src/guard.mjs';

// Synthetic policy: invented tokens only.
const POLICY_TEXT = `
# private tokens for the fixture organisation
projectnova
hq-internal.example
/TICKET-\\d+/
allow:fixtures/known-noise
`;

const policy = parsePolicy(POLICY_TEXT, '/elsewhere/.policy');

test('policy parses literals, regexes, comments, and allow rules', () => {
  assert.equal(policy.rules.length, 3);
  assert.equal(policy.rules[0].kind, 'literal');
  assert.equal(policy.rules[2].kind, 'regex');
  assert.deepEqual(policy.allow, ['fixtures/known-noise']);
});

test('literals match case-insensitively and report position', () => {
  const m = scanText('a.txt', 'shipped by ProjectNova today', policy);
  assert.equal(m.length, 1);
  assert.equal(m[0].rule, 1);
  assert.equal(m[0].line, 1);
  assert.equal(m[0].token, 'ProjectNova');
});

test('regex rules match', () => {
  const m = scanText('b.txt', 'see TICKET-4412 for details', policy);
  assert.equal(m.length, 1);
  assert.equal(m[0].rule, 3);
});

test('clean text yields no matches', () => {
  assert.deepEqual(scanText('c.txt', 'nothing to see here', policy), []);
});

test('report is redacted by default and explicit with --show', () => {
  const m = scanText('d.txt', 'projectnova appears', policy);
  const [redacted] = report(m);
  assert.ok(!redacted.includes('projectnova'), 'redacted report must not echo the token');
  const [shown] = report(m, { show: true });
  assert.ok(shown.includes('projectnova'));
});

test('a policy inside a scanned root is refused', () => {
  assert.throws(() => assertPolicyOutside('/repo/.policy', ['/repo']), UsageError);
  assert.doesNotThrow(() => assertPolicyOutside('/home/me/.policy', ['/repo']));
});

test('scan walks a tree, honours allow rules, and skips binaries', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crg-'));
  writeFileSync(path.join(root, 'leaky.md'), 'projectnova ships friday');
  writeFileSync(path.join(root, 'ok.md'), 'a perfectly public sentence');
  writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x89, 0x00, 0x50, 0x4e]));
  mkdirSync(path.join(root, 'fixtures', 'known-noise'), { recursive: true });
  writeFileSync(path.join(root, 'fixtures', 'known-noise', 'lock.json'), 'projectnova-as-noise');
  const result = scan([root], policy, { walk: true });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].file, 'leaky.md');
  assert.equal(result.skipped, 2); // the allow-listed file and the binary
});
