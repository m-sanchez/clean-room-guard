/**
 * clean-room-guard core: scan a tree destined for publication against a
 * private policy of forbidden tokens. The policy file is required, lives
 * outside the scanned tree by construction, and is never part of the output
 * unless explicitly asked for - a leak report should itself be safe to share.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ kind: 'literal' | 'regex', source: string, re: RegExp }} Rule
 * @typedef {{ rules: Rule[], allow: string[], path: string }} Policy
 * @typedef {{ file: string, line: number, column: number, rule: number, token: string, excerpt: string }} Match
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

/**
 * List candidate files. Inside a git work tree the publishable set is what
 * git tracks, so that is the default; `staged` swaps to the index; `walk`
 * forces a plain filesystem walk.
 * @param {string} root
 * @param {{ staged?: boolean, walk?: boolean }} [opts]
 * @returns {string[]} absolute paths
 */
export function listFiles(root, opts = {}) {
  const abs = path.resolve(root);
  if (!opts.walk) {
    try {
      const args = opts.staged
        ? ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']
        : ['ls-files', '-z'];
      const out = execFileSync('git', args, { cwd: abs, encoding: 'utf8' });
      return out
        .split('\0')
        .filter(Boolean)
        .map((p) => path.join(abs, p))
        .filter((p) => existsSync(p) && statSync(p).isFile());
    } catch {
      // not a git work tree (or git absent): fall through to the walk
    }
  }
  /** @type {string[]} */
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (ALWAYS_SKIP.has(name)) continue;
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) found.push(p);
    }
  };
  walk(abs);
  return found;
}

/**
 * @param {Buffer} head
 * @returns {boolean} true when the sniffed bytes look binary
 */
function looksBinary(head) {
  return head.includes(0);
}

/**
 * Scan one file's text against the policy.
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
      rule.re.lastIndex = 0;
      const m = rule.re.exec(lines[i]);
      if (m) {
        matches.push({
          file: relPath,
          line: i + 1,
          column: m.index + 1,
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
 * Scan roots and return every match.
 * @param {string[]} roots
 * @param {Policy} policy
 * @param {{ staged?: boolean, walk?: boolean, maxBytes?: number }} [opts]
 * @returns {{ matches: Match[], filesScanned: number, skipped: number }}
 */
export function scan(roots, policy, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  /** @type {Match[]} */
  const matches = [];
  let filesScanned = 0;
  let skipped = 0;
  for (const root of roots) {
    const abs = path.resolve(root);
    for (const file of listFiles(abs, opts)) {
      const rel = path.relative(abs, file).split(path.sep).join('/');
      if (policy.allow.some((frag) => rel.includes(frag))) {
        skipped++;
        continue;
      }
      const st = statSync(file);
      if (st.size > maxBytes) {
        skipped++;
        continue;
      }
      const fd = readFileSync(file);
      if (looksBinary(fd.subarray(0, 8192))) {
        skipped++;
        continue;
      }
      matches.push(...scanText(rel, fd.toString('utf8'), policy));
      filesScanned++;
    }
  }
  return { matches, filesScanned, skipped };
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
