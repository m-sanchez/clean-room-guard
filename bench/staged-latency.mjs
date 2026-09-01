#!/usr/bin/env node
/**
 * What the pre-commit hook actually costs.
 *
 * The advertised adoption path is `exec clean-room-guard --staged` in
 * .git/hooks/pre-commit, so the number that decides whether the hook
 * survives contact with a team is wall-clock time on a large `git add -A`.
 * This script builds a throwaway repository, stages N files, and times one
 * staged scan - so the numbers in the README are reproducible rather than
 * asserted.
 *
 *   node bench/staged-latency.mjs                # 100 and 1000 staged files
 *   node bench/staged-latency.mjs 100 1000 10000
 *   node bench/staged-latency.mjs --impl <path-to-another-guard.mjs> 1000
 *
 * `--impl` exists so the "before" column can be produced by pointing the
 * same harness at an older release rather than trusting a remembered number.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const implAt = argv.indexOf('--impl');
const implPath =
  implAt === -1 ? new URL('../src/guard.mjs', import.meta.url) : pathToFileURL(path.resolve(argv[implAt + 1]));
const consumed = new Set(implAt === -1 ? [] : [implAt, implAt + 1]);
const counts = argv
  .filter((_, i) => !consumed.has(i))
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
const sizes = counts.length > 0 ? counts : [100, 1000];

const { parsePolicy, scan } = await import(implPath.href);

// the README's own example policy: two literals and a regex
const policy = parsePolicy('projectnova\nhq-internal.example\n/TICKET-\\d+/\n', '<inline>');

// ~2 KB of plausible source per file, none of it matching the policy
const BODY = ('export const value = "a perfectly public sentence";\n'.repeat(40));

/** @param {number} n @returns {string} */
function stageRepo(n) {
  const repo = mkdtempSync(path.join(tmpdir(), 'crg-bench-'));
  const run = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'bench@example.invalid']);
  run(['config', 'user.name', 'Bench']);
  run(['config', 'core.autocrlf', 'false']);
  for (let i = 0; i < n; i++) {
    const dir = path.join(repo, 'pkg' + (i % 10), 'src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `mod${i}.ts`), BODY);
  }
  run(['add', '-A']);
  return repo;
}

console.log(`impl     ${implPath.pathname}`);
console.log(`node     ${process.version}`);
console.log(`git      ${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()}`);
console.log(`platform ${platform()} ${release()}`);
console.log('');
for (const n of sizes) {
  const repo = stageRepo(n);
  try {
    const started = performance.now();
    const result = scan([repo], policy, { staged: true });
    const ms = performance.now() - started;
    if (result.filesScanned !== n) {
      throw new Error(`scanned ${result.filesScanned} of ${n} staged files`);
    }
    console.log(
      `${String(n).padStart(6)} staged files  ${ms.toFixed(0).padStart(7)} ms  ` +
        `${Math.round(n / (ms / 1000)).toLocaleString('en-GB').padStart(8)} files/s`
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
