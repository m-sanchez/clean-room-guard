import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  UsageError,
  assertPolicyOutside,
  listFiles,
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

// binary handling has its own tests below: this one is about the walk and
// the allow rules, and a binary fixture here would let an extension-based
// implementation pass by accident.
test('scan walks a tree and honours allow rules', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crg-'));
  writeFileSync(path.join(root, 'leaky.md'), 'projectnova ships friday');
  writeFileSync(path.join(root, 'ok.md'), 'a perfectly public sentence');
  mkdirSync(path.join(root, 'fixtures', 'known-noise'), { recursive: true });
  writeFileSync(path.join(root, 'fixtures', 'known-noise', 'lock.json'), 'projectnova-as-noise');
  const result = scan([root], policy, { walk: true });
  assert.equal(result.matches.length, 1, 'the allowed path is excluded, the leaky one is not');
  assert.equal(result.matches[0].file, 'leaky.md');
  assert.equal(result.filesScanned, 2);
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

// --- claims the survey falsified -------------------------------------------

test('an empty allow: value is a usage error, not a licence to skip every file', () => {
  assert.throws(() => parsePolicy('projectnova\nallow:\n', '/elsewhere/.policy'), UsageError);
});

test('a malformed regex rule is a usage error, not a crash into the match exit code', () => {
  assert.throws(() => parsePolicy('/TICKET-[0-9/\n', '/elsewhere/.policy'), UsageError);
});

test('scanning zero files is never clean', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crg-empty-'));
  const result = scan([root], policy, { walk: true });
  assert.equal(result.filesScanned, 0);
  assert.ok(!result.clean, 'nothing examined is not a clean pass');
  const allowed = scan([root], policy, { walk: true, allowEmpty: true });
  assert.ok(allowed.clean, 'the explicit override accepts a legitimately empty root');
});

test('binaries are detected by content, NAMED, and dirty the result', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crg-bin-'));
  // NUL-bearing content under a text name: must be skipped and named
  writeFileSync(path.join(root, 'notes.txt'), Buffer.from([0x68, 0x69, 0x00, 0x21]));
  // plain text under a binary name: must be scanned
  writeFileSync(path.join(root, 'data.bin'), 'a perfectly public sentence');
  const result = scan([root], policy, { walk: true });
  assert.deepEqual(result.skippedBinary, ['notes.txt'], 'skips are by content sniff, not extension');
  assert.equal(result.filesScanned, 1, 'the text file named .bin is scanned');
  assert.ok(!result.clean, 'a file the scan could not examine is not clean');
  const allowed = scan([root], policy, { walk: true, allowSkips: true });
  assert.ok(allowed.clean, 'the explicit override accepts the skip');
  assert.deepEqual(allowed.skippedBinary, ['notes.txt'], 'and the skip is still named');
});

test('UTF-16 files are decoded and scanned, not dropped as binary', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crg-utf16-'));
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('shipped by projectnova\n', 'utf16le')]);
  writeFileSync(path.join(root, 'le.txt'), le);
  const beBody = Buffer.from('see TICKET-4412 today\n', 'utf16le');
  beBody.swap16();
  writeFileSync(path.join(root, 'be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]));
  const result = scan([root], policy, { walk: true });
  assert.deepEqual(result.skippedBinary, [], 'UTF-16 text is text');
  assert.equal(result.filesScanned, 2);
  assert.equal(result.matches.length, 2, 'a UTF-16 file full of forbidden tokens is not clean');
  assert.equal(result.matches[0].line, 1, 'and its position is reported like any other text');
});

test('a token in a file PATH is a finding, and the redacted report does not republish it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crg-path-'));
  mkdirSync(path.join(root, 'src', 'projectnova'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'projectnova', 'config.ts'), 'export const port = 8080;\n');
  const result = scan([root], policy, { walk: true });
  assert.equal(result.matches.length, 1, 'a directory named after the original is a leak');
  assert.equal(result.matches[0].kind, 'path');
  assert.equal(result.matches[0].line, 0, 'path findings are visibly not content findings');
  assert.ok(!result.clean);
  const [redacted] = report(result.matches);
  assert.ok(!redacted.includes('projectnova'), 'the report must not republish a path-borne token');
  assert.ok(redacted.includes('src/') && redacted.includes('/config.ts'), 'but it still says where');
  const [shown] = report(result.matches, { show: true });
  assert.ok(shown.includes('src/projectnova/config.ts'));
});

test('a content finding inside a leaky path is redacted in the path too', () => {
  const m = scanText('src/projectnova/config.ts', 'see TICKET-4412 for details', policy);
  assert.equal(m.length, 1);
  const [redacted] = report(m);
  assert.ok(!redacted.includes('projectnova'), 'the path is part of the report, so it is redacted too');
});

test('allow rules take precedence over path matches', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crg-allow-path-'));
  mkdirSync(path.join(root, 'fixtures', 'known-noise'), { recursive: true });
  writeFileSync(path.join(root, 'fixtures', 'known-noise', 'projectnova.json'), '{}');
  writeFileSync(path.join(root, 'ok.md'), 'a perfectly public sentence');
  const result = scan([root], policy, { walk: true });
  assert.deepEqual(result.matches, [], 'an allowed path is excluded from path scanning too');
  assert.ok(result.clean);
});

test('inside a git work tree the default scan is what git tracks', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'crg-tracked-'));
  const git = gitIn(repo);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'tracked.md'), 'a perfectly public sentence');
  git(['add', 'tracked.md']);
  writeFileSync(path.join(repo, 'untracked.md'), 'projectnova ships friday');
  const tracked = scan([repo], policy, {});
  assert.equal(tracked.filesScanned, 1, 'the publishable set is what git tracks');
  assert.equal(tracked.matches.length, 0);
  const walked = scan([repo], policy, { walk: true });
  assert.equal(walked.matches.length, 1, '--walk catches what you are about to git add');
});

test('--staged from a subdirectory scans the whole staged set, repo-relative', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'crg-sibling-'));
  const git = gitIn(repo);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(path.join(repo, 'sub'));
  mkdirSync(path.join(repo, 'other'));
  writeFileSync(path.join(repo, 'sub', 'ok.txt'), 'a perfectly public sentence');
  writeFileSync(path.join(repo, 'other', 'leak.txt'), 'token=projectnova');
  git(['add', '.']);
  const result = scan([path.join(repo, 'sub')], policy, { staged: true });
  assert.equal(result.matches.length, 1, 'a staged secret in a sibling directory must not escape the hook');
  assert.equal(result.matches[0].file, 'other/leak.txt', 'staged paths are reported repo-relative');
});

test('--staged refuses a policy anywhere in the repository, not just under the scanned root', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'crg-polrepo-'));
  const git = gitIn(repo);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(path.join(repo, 'sub'));
  writeFileSync(path.join(repo, 'sub', 'ok.txt'), 'a perfectly public sentence');
  writeFileSync(path.join(repo, 'policy.txt'), 'projectnova\n');
  git(['add', '.']);
  const inside = parsePolicy('projectnova\n', path.join(repo, 'policy.txt'));
  assert.throws(() => scan([path.join(repo, 'sub')], inside, { staged: true }), UsageError);
});

test('--staged scans a blob larger than the child-process buffer, not just the size cap', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'crg-bigblob-'));
  const git = gitIn(repo);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  // 1.25 MB: comfortably under the 5 MB cap the README documents, and
  // comfortably over execFileSync's 1 MB default buffer
  writeFileSync(path.join(repo, 'big.txt'), 'padding padding padding \n'.repeat(50000) + 'token=projectnova\n');
  git(['add', '.']);
  const result = scan([repo], policy, { staged: true });
  assert.equal(result.matches.length, 1, 'a file under the cap is scanned, whatever git had to stream');
  assert.equal(result.filesScanned, 1);
});

test('--staged never reads a blob it is going to skip for size', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'crg-lazy-'));
  const git = gitIn(repo);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  // over the child-process buffer, so listing it by reading it would throw
  writeFileSync(path.join(repo, 'huge.txt'), 'x'.repeat(1300000));
  writeFileSync(path.join(repo, 'ok.txt'), 'a perfectly public sentence');
  git(['add', '.']);
  const candidates = listFiles(repo, { staged: true });
  assert.equal(candidates.find((c) => c.rel === 'huge.txt').size, 1300000, 'the size is known before anything is read');
  const result = scan([repo], policy, { staged: true, maxBytes: 1024 });
  assert.deepEqual(result.skippedSize, ['huge.txt'], 'the cap is consulted before the blob is fetched');
  assert.equal(result.filesScanned, 1);
  assert.ok(!result.clean);
});
