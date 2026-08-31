#!/usr/bin/env node
/**
 * clean-room-guard CLI.
 *
 *   clean-room-guard [roots...] [--policy <file>] [--staged] [--walk]
 *                    [--show] [--max-bytes <n>]
 *
 * Exit codes: 0 clean · 1 matches found · 2 usage or policy error.
 */

import { readFileSync } from 'node:fs';
import {
  UsageError,
  assertPolicyOutside,
  parsePolicy,
  report,
  resolvePolicyPath,
  scan
} from '../src/guard.mjs';

function parseArgs(argv) {
  const opts = { roots: [], policy: undefined, staged: false, walk: false, show: false, maxBytes: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--policy') opts.policy = argv[++i];
    else if (a === '--staged') opts.staged = true;
    else if (a === '--walk') opts.walk = true;
    else if (a === '--show') opts.show = true;
    else if (a === '--max-bytes') opts.maxBytes = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown flag ${a}`);
    else opts.roots.push(a);
  }
  if (opts.roots.length === 0) opts.roots.push('.');
  return opts;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      'usage: clean-room-guard [roots...] [--policy <file>] [--staged] [--walk] [--show] [--max-bytes <n>]'
    );
    process.exit(0);
  }
  const policyPath = resolvePolicyPath(opts.policy);
  assertPolicyOutside(policyPath, opts.roots);
  const policy = parsePolicy(readFileSync(policyPath, 'utf8'), policyPath);
  if (policy.rules.length === 0) {
    throw new UsageError(`policy at ${policyPath} contains no rules; an empty policy proves nothing`);
  }
  const result = scan(opts.roots, policy, opts);
  for (const line of report(result.matches, { show: opts.show })) console.error(line);
  if (result.matches.length > 0) {
    console.error(
      `clean-room-guard: ${result.matches.length} match(es) across ${result.filesScanned} file(s) - do not publish`
    );
    process.exit(1);
  }
  console.log(`clean-room-guard: clean (${result.filesScanned} files scanned, ${result.skipped} skipped)`);
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`clean-room-guard: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
