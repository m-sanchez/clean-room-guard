import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  assert.equal(result.skippedBinary, 1);
  assert.ok(!result.clean);
});

test('two secrets on one line are two findings, not one', () => {
  const matches = scanText('x.md', 'projectnova met hq-internal.example today', policy);
  assert.equal(matches.length, 2);
});

test('an oversized file is named and dirties the result unless skips are allowed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crg-big-'));
  writeFileSync(path.join(root, 'big.txt'), 'projectnova '.repeat(10));
  writeFileSync(path.join(root, 'ok.txt'), 'public');
  const closed = scan([root], policy, { walk: true, maxBytes: 20 });
  assert.deepEqual(closed.skippedSize, ['big.txt']);
  assert.ok(!closed.clean, 'a file the scan could not examine is not clean');
  const allowed = scan([root], policy, { walk: true, maxBytes: 20, allowSkips: true });
  assert.ok(allowed.clean, 'the explicit override accepts the skip');
  assert.deepEqual(allowed.skippedSize, ['big.txt'], 'and the skip is still named');
});

test('the guards live in scan(): a library caller cannot bypass them', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crg-lib-'));
  writeFileSync(path.join(root, 'p.txt'), 'projectnova');
  const inside = parsePolicy('projectnova\n', path.join(root, 'policy.txt'));
  assert.throws(() => scan([root], inside, { walk: true }), UsageError);
  const empty = parsePolicy('# nothing\n', '/elsewhere/.policy');
  assert.throws(() => scan([root], empty, { walk: true }), /empty policy proves nothing/);
});

const gitIn = (repo) => (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

test('--staged reads the index, not the working tree', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'crg-staged-'));
  const git = gitIn(repo);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'config.txt'), 'token=projectnova');
  git(['add', 'config.txt']);
  // the secret is staged; the working tree is then cleaned - the classic
  // way a pre-commit scan gets fooled
  writeFileSync(path.join(repo, 'config.txt'), 'token=redacted');
  const result = scan([repo], policy, { staged: true });
  assert.equal(result.matches.length, 1, 'the staged blob still carries the secret');
  assert.equal(result.matches[0].file, 'config.txt');
});

test('--staged from a subdirectory still scans the staged set', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'crg-subdir-'));
  const git = gitIn(repo);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(path.join(repo, 'sub'));
  writeFileSync(path.join(repo, 'sub', 'notes.txt'), 'projectnova inside');
  git(['add', '.']);
  const result = scan([path.join(repo, 'sub')], policy, { staged: true });
  assert.equal(result.matches.length, 1, 'no silent zero-file pass from a subdirectory');
});
