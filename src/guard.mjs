/**
 * clean-room-guard core: scan a tree destined for publication against a
 * private policy of forbidden tokens. The policy file is required, must
 * live outside the scanned tree, and is never part of the output unless
 * explicitly asked for - a leak report should itself be safe to share.
 *
 * The structural guards (policy outside the tree, non-empty policy, a
 * policy that cannot silently exclude everything) live HERE in scan() and
 * parsePolicy(), not in the CLI wrapper, so a library caller gets the same
 * refusals a command-line caller does.
 *
 * The governing rule is that nothing unexamined counts as clean. Every way
 * a file can escape the scan - over the size cap, binary, excluded by an
 * allow rule that swallowed the tree, or simply absent because the root
 * held nothing - has to surface as a dirty result rather than an exit 0.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ kind: 'literal' | 'regex', source: string, re: RegExp }} Rule
 * @typedef {{ rules: Rule[], allow: string[], path: string }} Policy
 * @typedef {{ kind: 'content' | 'path', file: string, fileRedacted: string, line: number, column: number, rule: number, token: string, excerpt: string }} Match
 * @typedef {{ rel: string, size: number, read: () => Buffer }} Candidate
 */

const REGEX_LINE = /^\/(.+)\/([a-z]*)$/;

/**
 * Parse policy text: one rule per line, `#` comments, /regex/flags or
 * case-insensitive literal, `allow:<substring>` path exclusions.
 *
 * Both failure modes here are typos that would otherwise turn the scanner
 * into a no-op that reports success: `allow:` with no value excludes every
 * path (every string contains ''), and a malformed regex would throw a raw
 * SyntaxError past the CLI's handler into exit 1, the code reserved for
 * "matches found".
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
      const fragment = line.slice('allow:'.length).trim();
      if (fragment === '') {
        throw new UsageError(
          `policy at ${policyPath} has an allow: with no value\n` +
            'every path contains the empty string, so that line excludes the entire tree ' +
            'and the scan would pass having examined nothing\n' +
            'write the substring to exclude, or delete the line'
        );
      }
      allow.push(fragment);
      continue;
    }
    const m = REGEX_LINE.exec(line);
    if (m) {
      const flags = m[2].includes('g') ? m[2] : m[2] + 'g';
      let re;
      try {
        re = new RegExp(m[1], flags);
      } catch (err) {
        throw new UsageError(
          `policy at ${policyPath}: ${line} is not a valid regular expression\n` +
            `${err instanceof Error ? err.message : String(err)}\n` +
            'a policy typo is a policy error, not a leak: fix the rule rather than trusting the exit code'
        );
      }
      rules.push({ kind: 'regex', source: line, re });
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
// listings are metadata streams, not file contents: a large repository can
// easily push `ls-files -z` past execFileSync's 1 MB default and an ENOBUFS
// there would look like "git is missing" and fall through to a silent walk.
const LIST_MAX_BUFFER = 64 * 1024 * 1024;

/** @param {string} cwd @param {string[]} args @returns {string} */
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: LIST_MAX_BUFFER
  });
}

/**
 * The git toplevel for a `--staged` scan, resolved absolutely. A commit
 * publishes the whole index, not the subdirectory the hook happened to run
 * in, so the toplevel IS the scanned root once `--staged` is in play.
 * @param {string} root
 * @returns {string}
 */
export function repoToplevel(root) {
  const abs = path.resolve(root);
  try {
    return path.resolve(git(abs, ['rev-parse', '--show-toplevel']).trim());
  } catch (err) {
    throw new UsageError(`--staged needs a git repository at or above ${abs}: ${err}`);
  }
}

/**
 * Size every staged blob in ONE `git cat-file --batch-check` pass.
 *
 * The size cap exists so huge files are never read; sizing them by reading
 * them first defeated it, and cost a `git show` spawn per staged file on
 * top of the one the scan already needed.
 * @param {string} top repository toplevel
 * @param {string[]} paths repo-relative staged paths
 * @returns {({ oid: string, size: number } | null)[]} aligned with `paths`; null is a gitlink
 */
function sizeStagedBlobs(top, paths) {
  /** @type {Map<string, { oid: string, size: number } | null>} */
  const sized = new Map();
  // the batch protocol is newline-delimited; a path containing a newline is
  // legal in git and has to be resolved on its own rather than dropped
  const batched = paths.filter((p) => !p.includes('\n'));
  if (batched.length > 0) {
    const out = execFileSync('git', ['-C', top, 'cat-file', '--batch-check'], {
      input: batched.map((p) => `:${p}\n`).join(''),
      encoding: 'utf8',
      maxBuffer: LIST_MAX_BUFFER
    });
    const lines = out.split('\n').filter((l) => l !== '');
    if (lines.length !== batched.length) {
      throw new UsageError(
        `git cat-file returned ${lines.length} records for ${batched.length} staged paths; ` +
          'refusing to guess which file went unsized'
      );
    }
    batched.forEach((rel, i) => {
      const [oid, type, size] = lines[i].split(' ');
      // a gitlink (submodule pointer) has no file content in this index, but
      // its PATH still publishes, so it stays a candidate with nothing to read
      if (type === 'commit') {
        sized.set(rel, null);
        return;
      }
      if (type !== 'blob') {
        throw new UsageError(
          `staged path ${rel} resolved to "${lines[i]}", not a blob; refusing to skip it silently`
        );
      }
      sized.set(rel, { oid, size: Number(size) });
    });
  }
  return paths.map((rel) => {
    const entry = sized.get(rel);
    if (entry !== undefined) return entry;
    const oid = git(top, ['rev-parse', `:${rel}`]).trim();
    return { oid, size: Number(git(top, ['cat-file', '-s', oid]).trim()) };
  });
}

// One `git cat-file --batch` call answers a whole window of blobs. A spawn
// per staged file is the entire cost of the pre-commit hook on Windows
// (measured at ~28 ms each); batching turns a 1,000-file `git add -A` from
// half a minute into well under a second. See bench/staged-latency.mjs.
const READ_CHUNK_FILES = 128;
const READ_CHUNK_BYTES = 8 * 1024 * 1024;
// a blob only joins a window speculatively if it is small: the point of the
// size cap is that big files are never read, and prefetching would undo it
const PREFETCH_MAX_BYTES = 1024 * 1024;

/**
 * Staged candidates whose contents come from the index blob, fetched in
 * batched windows on first read and dropped once handed over, so peak
 * memory is one window rather than the whole staged set.
 * @param {string} top repository toplevel
 * @param {string[]} paths repo-relative staged paths
 * @returns {Candidate[]}
 */
function stagedCandidates(top, paths) {
  if (paths.length === 0) return [];
  const entries = sizeStagedBlobs(top, paths);
  /** @type {Map<number, Buffer>} */
  const fetched = new Map();

  /** @param {number} from index whose blob is wanted; always included */
  const fill = (from) => {
    /** @type {number[]} */
    const group = [];
    let budget = READ_CHUNK_BYTES;
    for (let i = from; i < entries.length && group.length < READ_CHUNK_FILES; i++) {
      const entry = entries[i];
      if (entry === null || fetched.has(i)) continue;
      if (i !== from && (entry.size > PREFETCH_MAX_BYTES || entry.size > budget)) break;
      budget -= entry.size;
      group.push(i);
    }
    const bytes = group.reduce((total, i) => total + entries[i].size, 0);
    const out = execFileSync('git', ['-C', top, 'cat-file', '--batch'], {
      input: group.map((i) => `${entries[i].oid}\n`).join(''),
      maxBuffer: bytes + group.length * 128 + 4096
    });
    let at = 0;
    for (const i of group) {
      const nl = out.indexOf(0x0a, at);
      if (nl === -1) throw new UsageError(`git cat-file --batch ended early at staged path ${paths[i]}`);
      const header = out.toString('utf8', at, nl);
      const size = Number(header.split(' ')[2]);
      if (!header.includes(' blob ') || !Number.isFinite(size)) {
        throw new UsageError(`git cat-file --batch answered "${header}" for staged path ${paths[i]}`);
      }
      fetched.set(i, out.subarray(nl + 1, nl + 1 + size));
      at = nl + 1 + size + 1;
    }
  };

  return paths.map((rel, i) => {
    const entry = entries[i];
    if (entry === null) return { rel, size: 0, read: () => Buffer.alloc(0) };
    return {
      rel,
      size: entry.size,
      // content from the index blob, never the working tree
      read: () => {
        if (!fetched.has(i)) fill(i);
        const blob = fetched.get(i);
        fetched.delete(i);
        return blob;
      }
    };
  });
}

/**
 * List candidate files under one root. Inside a git work tree the
 * publishable set is what git tracks; `staged` reads the INDEX - both the
 * file list and the file CONTENT - because the index is what a commit
 * would actually publish, not whatever the working tree happens to hold.
 *
 * A `--staged` listing covers the whole index and reports repo-relative
 * paths: a commit made from a subdirectory still publishes its siblings,
 * so scanning only the subdirectory would pass a hook while the commit
 * carried a secret one directory over.
 * @param {string} root
 * @param {{ staged?: boolean, walk?: boolean }} [opts]
 * @returns {Candidate[]}
 */
export function listFiles(root, opts = {}) {
  const abs = path.resolve(root);
  if (!opts.walk) {
    if (opts.staged) {
      const top = repoToplevel(abs);
      let names;
      try {
        names = git(top, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
      } catch (err) {
        throw new UsageError(`--staged could not read the index at ${top}: ${err}`);
      }
      return stagedCandidates(top, names.split('\0').filter(Boolean));
    }
    try {
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
    } catch {
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
 * Decode a file's bytes for scanning, or report it as unreadable.
 *
 * A UTF-16 BOM is decoded and scanned: UTF-16-encoded ASCII is NUL-dense,
 * so a NUL sniff alone drops every UTF-16 file - which on a Windows-origin
 * codebase is exactly where the internal hostnames live. Everything else
 * carrying a NUL in the first 8 KB is treated as binary, and a binary file
 * is NAMED and dirties the result rather than vanishing from the count.
 * @param {Buffer} content
 * @returns {string | null} null when the bytes are not decodable text
 */
export function decodeText(content) {
  if (content.length >= 2) {
    if (content[0] === 0xff && content[1] === 0xfe) {
      return content.subarray(2).toString('utf16le');
    }
    if (content[0] === 0xfe && content[1] === 0xff) {
      const body = content.subarray(2);
      const even = body.length % 2 === 0 ? body : body.subarray(0, body.length - 1);
      return Buffer.from(even).swap16().toString('utf16le');
    }
  }
  if (content.subarray(0, 8192).includes(0)) return null;
  return content.toString('utf8');
}

/**
 * Every span of `text` a policy rule matches.
 * @param {string} text
 * @param {Policy} policy
 * @returns {{ start: number, end: number, rule: number, token: string }[]}
 */
function ruleSpans(text, policy) {
  const spans = [];
  policy.rules.forEach((rule, index) => {
    for (const m of text.matchAll(rule.re)) {
      if (m[0].length === 0) continue;
      const start = m.index ?? 0;
      spans.push({ start, end: start + m[0].length, rule: index + 1, token: m[0] });
    }
  });
  return spans;
}

/**
 * Replace matched spans with a same-width run of `*`, so the surviving
 * shape still locates the finding without republishing the token.
 * @param {string} text
 * @param {{ start: number, end: number }[]} spans
 * @returns {string}
 */
function maskSpans(text, spans) {
  if (spans.length === 0) return text;
  let out = '';
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.end <= at) continue;
    const start = Math.max(span.start, at);
    out += text.slice(at, start) + '*'.repeat(span.end - start);
    at = span.end;
  }
  return out + text.slice(at);
}

/**
 * Scan a file's PATH against the policy. A directory or filename carrying
 * the original's name is a first-order clean-room leak that no amount of
 * rewriting the file bodies removes, and it is invisible to a scanner that
 * only reads contents.
 * @param {string} relPath
 * @param {Policy} policy
 * @returns {Match[]}
 */
export function scanPath(relPath, policy) {
  const spans = ruleSpans(relPath, policy);
  if (spans.length === 0) return [];
  const fileRedacted = maskSpans(relPath, spans);
  return spans.map((span) => ({
    kind: 'path',
    file: relPath,
    fileRedacted,
    line: 0,
    column: span.start + 1,
    rule: span.rule,
    token: span.token,
    excerpt: relPath
  }));
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
          kind: 'content',
          file: relPath,
          fileRedacted: relPath,
          line: i + 1,
          column: (m.index ?? 0) + 1,
          rule: index + 1,
          token: m[0],
          excerpt: lines[i].trim().slice(0, 120)
        });
      }
    }
  });
  // the path travels with every finding, so it is redacted with the same
  // care as the excerpt - a content hit inside src/<secret>/ must not
  // republish the secret in its own report
  if (matches.length > 0) {
    const fileRedacted = maskSpans(relPath, ruleSpans(relPath, policy));
    for (const m of matches) m.fileRedacted = fileRedacted;
  }
  return matches;
}

/**
 * Scan roots and return every match. Fail-closed on everything unexamined:
 * a file the scan could not read (over the size cap, or binary) is NAMED
 * and its presence alone makes the result dirty without `allowSkips`, and
 * a run that examined NO files at all is dirty without `allowEmpty` - a
 * scanner that looked at nothing has proved nothing.
 * @param {string[]} roots
 * @param {Policy} policy
 * @param {{ staged?: boolean, walk?: boolean, maxBytes?: number, allowSkips?: boolean, allowEmpty?: boolean }} [opts]
 * @returns {{ matches: Match[], filesScanned: number, skippedBinary: string[], skippedSize: string[], roots: string[], clean: boolean }}
 */
export function scan(roots, policy, opts = {}) {
  // with --staged the index of the whole repository is what publishes, so
  // the toplevel - not the directory the hook ran in - is the scanned root
  const scanned = [...new Set(roots.map((r) => (opts.staged ? repoToplevel(r) : path.resolve(r))))];
  // an inline policy has no path to check; a file-backed one must live
  // outside every scanned root
  if (policy.path !== '<inline>') assertPolicyOutside(path.resolve(policy.path), scanned);
  if (policy.rules.length === 0) {
    throw new UsageError(`policy at ${policy.path} contains no rules; an empty policy proves nothing`);
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  /** @type {Match[]} */
  const matches = [];
  let filesScanned = 0;
  /** @type {string[]} */
  const skippedBinary = [];
  /** @type {string[]} */
  const skippedSize = [];
  for (const root of scanned) {
    for (const file of listFiles(root, opts)) {
      if (policy.allow.some((frag) => file.rel.includes(frag))) continue;
      // the path is scanned before the content checks: a file too big or
      // too binary to read still publishes its name
      matches.push(...scanPath(file.rel, policy));
      if (file.size > maxBytes) {
        skippedSize.push(file.rel);
        continue;
      }
      const text = decodeText(file.read());
      if (text === null) {
        skippedBinary.push(file.rel);
        continue;
      }
      matches.push(...scanText(file.rel, text, policy));
      filesScanned++;
    }
  }
  const unscanned = skippedSize.length + skippedBinary.length;
  const examinedNothing = filesScanned === 0 && opts.allowEmpty !== true;
  const clean =
    matches.length === 0 && !examinedNothing && (opts.allowSkips === true || unscanned === 0);
  return { matches, filesScanned, skippedBinary, skippedSize, roots: scanned, clean };
}

/**
 * Render a report. Redacted by default: the report must be safe to paste
 * into an issue or a chat without republishing the token it caught - which
 * includes the token when it is part of the PATH, masked to a same-width
 * run of `*` so the line still says where to look.
 * @param {Match[]} matches
 * @param {{ show?: boolean }} [opts]
 * @returns {string[]}
 */
export function report(matches, opts = {}) {
  return matches.map((m) => {
    const file = opts.show ? m.file : (m.fileRedacted ?? m.file);
    if (m.kind === 'path') {
      return opts.show
        ? `path-match ${file}:${m.column} rule#${m.rule} "${m.token}"`
        : `path-match ${file}:${m.column} rule#${m.rule}`;
    }
    return opts.show
      ? `match ${file}:${m.line}:${m.column} rule#${m.rule} "${m.token}" :: ${m.excerpt}`
      : `match ${file}:${m.line}:${m.column} rule#${m.rule}`;
  });
}
