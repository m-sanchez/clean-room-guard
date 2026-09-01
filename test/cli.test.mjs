import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BIN = new URL('../bin/clean-room-guard.mjs', import.meta.url).pathname
  .replace(/^\/([A-Za-z]):/, '$1:');

/** @param {string[]} args @param {string} cwd */
function run(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout), stderr: String(err.stderr) };
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'crg-cli-'));
writeFileSync(path.join(root, 'notes.md'), 'projectnova appears here');
const policyPath = path.join(mkdtempSync(path.join(tmpdir(), 'crg-pol-')), 'policy.txt');
writeFileSync(policyPath, 'projectnova\n');

test('a match exits 1 with a redacted report', () => {
  const r = run([root, '--walk', '--policy', policyPath], root);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /match notes\.md:1:1 rule#1/);
  assert.ok(!r.stderr.includes('projectnova'));
});

test('a clean tree exits 0', () => {
  const clean = mkdtempSync(path.join(tmpdir(), 'crg-clean-'));
  writeFileSync(path.join(clean, 'ok.md'), 'public words');
  const r = run([clean, '--walk', '--policy', policyPath], clean);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /clean/);
});

test('a missing policy exits 2, never a clean pass', () => {
  const r = run([root, '--walk', '--policy', path.join(root, 'no-such-policy')], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no policy file/);
});

test('an empty policy exits 2', () => {
  const empty = path.join(path.dirname(policyPath), 'empty.txt');
  writeFileSync(empty, '# only a comment\n');
  const r = run([root, '--walk', '--policy', empty], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no rules/);
});

test('a policy inside the scanned root exits 2', () => {
  const inside = path.join(root, 'policy-inside.txt');
  writeFileSync(inside, 'projectnova\n');
  const r = run([root, '--walk', '--policy', inside], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /inside scanned root/);
});

// --- the exit-code contract, pinned end to end ------------------------------

test('scanning zero files exits 1, never a clean pass', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'crg-cli-empty-'));
  const r = run([empty, '--walk', '--policy', policyPath], empty);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /scanned 0 files/);
  const allowed = run([empty, '--walk', '--allow-empty', '--policy', policyPath], empty);
  assert.equal(allowed.code, 0, 'the explicit override accepts a legitimately empty root');
});

test('a malformed regex in the policy exits 2, not the code reserved for matches', () => {
  const bad = path.join(path.dirname(policyPath), 'bad-regex.txt');
  writeFileSync(bad, '/TICKET-[0-9/\n');
  const r = run([root, '--walk', '--policy', bad], root);
  assert.equal(r.code, 2, 'a policy typo is a policy error, not a leak');
  assert.match(r.stderr, /not a valid regular expression/);
  assert.ok(!r.stderr.includes('at Object.'), 'and it is a message, not a stack trace');
});

test('an empty allow: value in the policy exits 2', () => {
  const bad = path.join(path.dirname(policyPath), 'empty-allow.txt');
  writeFileSync(bad, 'projectnova\nallow:\n');
  const r = run([root, '--walk', '--policy', bad], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /allow: with no value/);
});

test('a flag with a missing value is a usage error, never a silent fallback', () => {
  const r = run([root, '--walk', '--policy'], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--policy needs a value/);
  const bad = run([root, '--walk', '--policy', policyPath, '--max-bytes', 'lots'], root);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not a positive number/);
});

test('an unscanned binary is named in the output and exits 1', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crg-cli-bin-'));
  writeFileSync(path.join(dir, 'ok.md'), 'public words');
  writeFileSync(path.join(dir, 'notes.txt'), Buffer.from([0x68, 0x69, 0x00, 0x21]));
  const r = run([dir, '--walk', '--policy', policyPath], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unscanned \(binary\): notes\.txt/);
  const allowed = run([dir, '--walk', '--allow-skip', '--policy', policyPath], dir);
  assert.equal(allowed.code, 0);
});

test('a token in a path exits 1 and no output stream echoes the token', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crg-cli-path-'));
  mkdirSync(path.join(dir, 'src', 'projectnova'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'projectnova', 'config.ts'), 'export const port = 8080;\n');
  const r = run([dir, '--walk', '--policy', policyPath], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /path-match/);
  assert.ok(!(r.stdout + r.stderr).includes('projectnova'), 'the public log must not carry the token');
});

test('the documented pre-commit hook fails a commit whose sibling package leaks', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'crg-cli-hook-'));
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(path.join(repo, 'pkg-a'));
  mkdirSync(path.join(repo, 'pkg-b'));
  writeFileSync(path.join(repo, 'pkg-a', 'ok.txt'), 'public words');
  writeFileSync(path.join(repo, 'pkg-b', 'leak.txt'), 'token=projectnova');
  git(['add', '.']);
  // exactly the recipe: `exec clean-room-guard --staged`, run by a hook
  // whose cwd is the package that triggered it
  const r = run(['--staged', '--policy', policyPath], path.join(repo, 'pkg-a'));
  assert.equal(r.code, 1, 'the commit carries the secret even though this package does not');
  assert.match(r.stderr, /match pkg-b\/leak\.txt:1:/);
});
