#!/usr/bin/env node
/**
 * clean-room-guard CLI.
 *
 *   clean-room-guard [roots...] [--policy <file>] [--staged] [--walk]
 *                    [--show] [--max-bytes <n>] [--allow-skip] [--version]
 *
 * Exit codes: 0 clean - 1 matches found or unscanned files present - 2
 * usage or policy error. A flag with a missing value is a usage error,
 * never a silent fallback.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UsageError,
  parsePolicy,
  report,
  resolvePolicyPath,
  scan
} from '../src/guard.mjs';

function requireValue(argv, i, flag) {
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
  return v;
}

function parseArgs(argv) {
  const opts = { roots: [], policy: undefined, staged: false, walk: false, show: false, maxBytes: undefined, allowSkips: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--policy') opts.policy = requireValue(argv, i++, '--policy');
    else if (a === '--staged') opts.staged = true;
    else if (a === '--walk') opts.walk = true;
    else if (a === '--show') opts.show = true;
    else if (a === '--allow-skip') opts.allowSkips = true;
    else if (a === '--max-bytes') {
      const raw = requireValue(argv, i++, '--max-bytes');
      opts.maxBytes = Number(raw);
      if (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0) {
        throw new UsageError(`--max-bytes got "${raw}", not a positive number`);
      }
    } else if (a === '--version') opts.version = true;
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
      'usage: clean-room-guard [roots...] [--policy <file>] [--staged] [--walk] [--show] [--max-bytes <n>] [--allow-skip]'
    );
    process.exit(0);
  }
  if (opts.version) {
    const pkg = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
    );
    console.log(pkg.version);
    process.exit(0);
  }
  const policyPath = resolvePolicyPath(opts.policy);
  const policy = parsePolicy(readFileSync(policyPath, 'utf8'), policyPath);
  const result = scan(opts.roots, policy, opts);
  for (const line of report(result.matches, { show: opts.show })) console.error(line);
  for (const skipped of result.skippedSize) {
    console.error(`unscanned (over size cap): ${skipped}`);
  }
  if (!result.clean) {
    const why =
      result.matches.length > 0
        ? `${result.matches.length} match(es)`
        : `${result.skippedSize.length} file(s) unscanned (pass --allow-skip to accept)`;
    console.error(`clean-room-guard: ${why} across ${result.filesScanned} file(s) scanned - do not publish`);
    process.exit(1);
  }
  console.log(
    `clean-room-guard: clean (${result.filesScanned} files scanned, ${result.skippedBinary} binary skipped${result.skippedSize.length ? `, ${result.skippedSize.length} size-skipped by --allow-skip` : ''})`
  );
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`clean-room-guard: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
