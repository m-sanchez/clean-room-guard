/**
 * clean-room-guard core: scan a tree destined for publication against a
 * private policy of forbidden tokens. The policy file is required, must
 * live outside the scanned tree, and is never part of the output unless
 * explicitly asked for - a leak report should itself be safe to share.
 *
 * The structural guards (policy outside the tree, non-empty policy) live
 * HERE in scan(), not in the CLI wrapper, so a library caller gets the
 * same refusals a command-line caller does.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ kind: 'literal' | 'regex', source: string, re: RegExp }} Rule
 * @typedef {{ rules: Rule[], allow: string[], path: string }} Policy
 * @typedef {{ file: string, line: number, column: number, rule: number, token: string, excerpt: string }} Match
 * @typedef {{ rel: string, size: number, read: () => Buffer }} Candidate
 */

const REGEX_LINE = /^\/(.+)\/([a-z]*)$/;

/**
 * Parse policy text: one rule per line, `#` comments, /regex/flags or
 * case-insensitive literal, `allow:<substring>` path exclusions.
 * @param {string} text
 * @param {string} policyPath
 * @returns {Policy}
 */
export function parsePolicy(text, policyPath = '<inline>') {
  /** @type {Rule[]} */
  const rules = [];
  /** @type {string[]} */
  const allow = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('allow:')) {
      allow.push(line.slice('allow:'.length).trim());
      continue;
    }
    const m = REGEX_LINE.exec(line);
    if (m) {
      rules.push({ kind: 'regex', source: line, re: new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') });
    } else {
      const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rules.push({ kind: 'literal', source: line, re: new RegExp(escaped, 'gi') });
    }
  }
  return { rules, allow, path: policyPath };
}

/**
 * Resolve the policy location: explicit flag, then $CLEAN_ROOM_POLICY, then
 * ~/.clean-room-policy. Missing policy is a usage error, not a clean pass.
 * @param {string | undefined} flagValue
 * @returns {string}
 */
export function resolvePolicyPath(flagValue) {
  const candidate =
    flagValue ?? process.env.CLEAN_ROOM_POLICY ?? path.join(homedir(), '.clean-room-policy');
  if (!existsSync(candidate)) {
    throw new UsageError(
      `no policy file at ${candidate}\n` +
        'provide one via --policy <file>, $CLEAN_ROOM_POLICY, or ~/.clean-room-policy\n' +
        'the policy holds your private tokens and must live OUTSIDE any published tree'
    );
  }
  return path.resolve(candidate);
}

export class UsageError extends Error {}

/**
 * The structural guard: a policy inside a scanned root would publish the
 * very list it exists to protect. Refuse to run rather than warn.
 * @param {string} policyPath
 * @param {string[]} roots
 */
export function assertPolicyOutside(policyPath, roots) {
  for (const root of roots) {
    const rel = path.relative(path.resolve(root), policyPath);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      throw new UsageError(
        `policy file ${policyPath} sits inside scanned root ${root}\n` +
          'the list itself is the leak: move it outside the tree you are about to publish'
      );
    }
  }
}

const ALWAYS_SKIP = new Set(['.git', 'node_modules']);
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** @param {string} cwd @param {string[]} args @returns {string} */
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** @param {string} cwd @param {string[]} args @returns {Buffer} */
function gitBuffer(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args]);
}

/**
 * List candidate files under one root. Inside a git work tree the
 * publishable set is what git tracks; `staged` reads the INDEX - both the
 * file list and the file CONTENT - because the index is what a commit
 * would actually publish, not whatever the working tree happens to hold.
 * Staged paths are resolved against the repository root, so running from a
 * subdirectory cannot silently produce an empty scan.
 * @param {string} root
 * @param {{ staged?: boolean, walk?: boolean }} [opts]
 * @returns {Candidate[]}
 */
export function listFiles(root, opts = {}) {
  const abs = path.resolve(root);
  if (!opts.walk) {
    try {
      if (opts.staged) {
        const top = git(abs, ['rev-parse', '--show-toplevel']).trim();
        const out = git(top, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
        return out
          .split('\0')
          .filter(Boolean)
          .map((repoRel) => {
            const absolute = path.join(top, repoRel);
            return {
              rel: path.relative(abs, absolute).split(path.sep).join('/'),
              // content from the index blob, never the working tree
              read: () => gitBuffer(top, ['show', `:${repoRel}`]),
              size: gitBuffer(top, ['show', `:${repoRel}`]).length
            };
          })
          .filter((c) => !c.rel.startsWith('..'));
      }
      const out = git(abs, ['ls-files', '-z']);
      return out
        .split('\0')
        .filter(Boolean)
        .map((p) => path.join(abs, p))
        .filter((p) => existsSync(p) && statSync(p).isFile())
        .map((p) => ({
          rel: path.relative(abs, p).split(path.sep).join('/'),
          size: statSync(p).size,
          read: () => readFileSync(p)
        }));
    } catch (err) {
      if (opts.staged) {
        throw new UsageError(`--staged needs a git repository at or above ${abs}: ${err}`);
      }
      // not a git work tree (or git absent): fall through to the walk
    }
  }
  /** @type {Candidate[]} */
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (ALWAYS_SKIP.has(name)) continue;
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        found.push({
          rel: path.relative(abs, p).split(path.sep).join('/'),
          size: st.size,
          read: () => readFileSync(p)
        });
      }
    }
  };
  walk(abs);
  return found;
}

/**
 * @param {Buffer} head
 * @returns {boolean} true when the sniffed bytes look binary (NUL in the
 * first 8KB; UTF-16 and NUL-free binaries are scanned as text - see README)
 */
function looksBinary(head) {
  return head.includes(0);
}

/**
 * Scan one file's text against the policy. Every rule reports EVERY match
 * on a line; two secrets on one line are two findings.
 * @param {string} relPath repo-relative path, used in reports
 * @param {string} text
 * @param {Policy} policy
 * @returns {Match[]}
 */
export function scanText(relPath, text, policy) {
  /** @type {Match[]} */
  const matches = [];
  const lines = text.split('\n');
  policy.rules.forEach((rule, index) => {
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(rule.re)) {
        matches.push({
          file: relPath,
          line: i + 1,
          column: (m.index ?? 0) + 1,
          rule: index + 1,
          token: m[0],
          excerpt: lines[i].trim().slice(0, 120)
        });
      }
    }
  });
  return matches;
}

/**
 * Scan roots and return every match. Fail-closed on skips: a file the scan
 * could not examine (over the size cap) is NAMED, and without
 * `allowSkips` its presence alone makes the result dirty - a 6MB file of
 * secrets must not pass because it was big.
 * @param {string[]} roots
 * @param {Policy} policy
 * @param {{ staged?: boolean, walk?: boolean, maxBytes?: number, allowSkips?: boolean }} [opts]
 * @returns {{ matches: Match[], filesScanned: number, skippedBinary: number, skippedSize: string[], clean: boolean }}
 */
export function scan(roots, policy, opts = {}) {
  // an inline policy has no path to check; a file-backed one must live
  // outside every scanned root
  if (policy.path !== '<inline>') assertPolicyOutside(path.resolve(policy.path), roots);
  if (policy.rules.length === 0) {
    throw new UsageError(`policy at ${policy.path} contains no rules; an empty policy proves nothing`);
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  /** @type {Match[]} */
  const matches = [];
  let filesScanned = 0;
  let skippedBinary = 0;
  /** @type {string[]} */
  const skippedSize = [];
  for (const root of roots) {
    for (const file of listFiles(root, opts)) {
      if (policy.allow.some((frag) => file.rel.includes(frag))) continue;
      if (file.size > maxBytes) {
        skippedSize.push(file.rel);
        continue;
      }
      const content = file.read();
      if (looksBinary(content.subarray(0, 8192))) {
        skippedBinary++;
        continue;
      }
      matches.push(...scanText(file.rel, content.toString('utf8'), policy));
      filesScanned++;
    }
  }
  const clean = matches.length === 0 && (opts.allowSkips === true || skippedSize.length === 0);
  return { matches, filesScanned, skippedBinary, skippedSize, clean };
}

/**
 * Render a report. Redacted by default: the report must be safe to paste
 * into an issue or a chat without republishing the token it caught.
 * @param {Match[]} matches
 * @param {{ show?: boolean }} [opts]
 * @returns {string[]}
 */
export function report(matches, opts = {}) {
  return matches.map((m) =>
    opts.show
      ? `match ${m.file}:${m.line}:${m.column} rule#${m.rule} "${m.token}" :: ${m.excerpt}`
      : `match ${m.file}:${m.line}:${m.column} rule#${m.rule}`
  );
}
