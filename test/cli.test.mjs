import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
