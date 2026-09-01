# clean-room-guard

![Node](https://img.shields.io/badge/node-%3E%3D18-5FA04E?logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-B45309)
[![CI](https://github.com/m-sanchez/clean-room-guard/actions/workflows/test.yml/badge.svg)](https://github.com/m-sanchez/clean-room-guard/actions/workflows/test.yml)
![Exit codes](https://img.shields.io/badge/exit_codes-0%2F1%2F2-6E6E6E)
![License](https://img.shields.io/badge/license-MIT-6E6E6E)
[![npm](https://img.shields.io/npm/v/@m-sanchez/clean-room-guard?color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@m-sanchez/clean-room-guard)

> **In plain English:** this scans code extracted from private work to make sure none of the original's fingerprints leaked in before you publish it.

Pre-publication scanning with a private local denylist that never enters the
repository.

[More tools](https://github.com/m-sanchez) · [Working rules](https://miguelsanchez.co.uk/ethics)

*Provenance: this came out of one body of production LLM work, extracted and
generalised into a standalone package. First published 2026-08-31.*

Before a tree goes public, scan it for the tokens that must not travel with
it: organisation names, internal hostnames, ticket prefixes, machine paths.
The twist most scanners miss: **the list of forbidden tokens is itself the
most sensitive file involved**. clean-room-guard is built around that fact.

- The policy file is required and lives outside the scanned tree: the tool
  **refuses to run** if the policy sits inside any scanned root. The list
  cannot ship with the tree it guards, by construction.
- Reports are **redacted by default**: `match src/config.ts:14:8 rule#3`.
  A leak report you can paste into an issue without republishing the leak -
  including when the token is in the *path*, which is masked to a same-width
  run of `*`. `--show` reveals tokens when you are somewhere safe.
- **Paths are scanned as content.** `src/projectnova/config.ts` is a leak
  even when every file body is clean: a directory named after the original
  survives any amount of rewriting the code. Path findings are reported as
  `path-match src/***********/config.ts:5 rule#1`, visibly distinct from a
  content hit and carrying nothing you cannot paste in public.
- Inside a git work tree it scans **what git tracks**, the set that would
  actually publish, not whatever happens to be on disk. `--staged` scans
  **the index blobs themselves**, so staging a secret and then cleaning the
  working copy cannot fool a pre-commit hook - and it scans the whole
  index, so a hook fired from a subdirectory of a monorepo cannot silently
  miss the sibling package the commit also carries.
- **Nothing the scan did not examine counts as clean.** Files over the size
  cap (5 MB default, `--max-bytes` to change) *and* files that sniff as
  binary are both **named** in the output and fail the scan unless you pass
  `--allow-skip` explicitly. A UTF-16 BOM is decoded and scanned as text:
  UTF-16-encoded ASCII is NUL-dense, so a NUL sniff on its own drops every
  UTF-16 file, which on a Windows-origin codebase is exactly where the
  internal hostnames live. And a run that examined **no files at all** - an
  untracked root, a policy typo that excluded the tree - fails too, rather
  than printing a reassuring `clean`.
- **The guards live in the library.** `scan()` itself refuses a policy
  inside a scanned root and an empty policy, and `parsePolicy()` refuses
  the typos that would quietly turn the scanner into a no-op; the CLI is a
  thin wrapper, not the enforcement point.

## Install

```bash
npm install -D @m-sanchez/clean-room-guard
```

Also installable from a pinned git tag (plain JavaScript, runs anywhere node
18+ does): `github:m-sanchez/clean-room-guard#v3.0.0`. CI proves the packed
tarball installs, imports, catches a planted token without echoing it into
the log, and honours the whole exit-code contract below. After install the
`clean-room-guard` command is on your path via `npx`.

```bash
# scan the current repo against ~/.clean-room-policy
npx clean-room-guard

# a build output directory is usually untracked, so walk it rather than
# asking git what it tracks there; reveal matched tokens
npx clean-room-guard ./dist --walk --policy ~/policies/acme.txt --show
```

Exit codes: `0` clean · `1` matches found, unscanned files present, or
nothing examined at all · `2` usage or policy error. A missing policy, an
empty policy, an `allow:` line with no value and a malformed regex rule are
all errors, never a clean pass; a flag with a missing value is a usage
error, never a silent fallback. Scanning zero files is a failure - pass
`--allow-empty` if a root really is expected to be empty.

## Policy format

One rule per line. `#` comments. `/slashes/i` for a regex; anything else is
a case-insensitive literal. `allow:<substring>` excludes paths containing
the substring (lockfiles full of random base64, vendored noise), and takes
precedence over path matching.

```text
# ~/.clean-room-policy - never committed anywhere
projectnova
hq-internal.example
/TICKET-\d+/
allow:package-lock.json
```

`allow:` with nothing after it is rejected: every path contains the empty
string, so that one-character typo would exclude the whole tree and the
scan would pass having read nothing.

## Recipes

Pre-commit hook (`.git/hooks/pre-commit`):

```bash
#!/bin/sh
exec clean-room-guard --staged
```

What that hook costs, measured by `npm run bench`
([bench/staged-latency.mjs](bench/staged-latency.mjs)) on Windows 11, node
v24.9.0, git 2.45.1 - one staged scan of ~2 KB source files:

| staged files | 2.0.1 | 3.0.0 |
| --: | --: | --: |
| 100 | 7.1 s | 0.21 s |
| 1,000 | 61.3 s | 0.80 s |
| 10,000 | not measured | 8.0 s |

2.0.1 spent two `git show` spawns per staged file and read every blob just
to learn its size; 3.0.0 sizes the whole index in one `git cat-file
--batch-check` and streams contents in batched windows, so the spawn count
stops tracking the file count. Process spawns are dearest on Windows, which
is why the numbers above are the ones worth quoting - re-run the script on
your own machine, the `--impl` flag points it at any older copy of
`src/guard.mjs` for the comparison column.

CI, with the policy delivered from a secret store rather than the repo:

```yaml
- run: printf '%s' "$CLEAN_ROOM_POLICY_BODY" > /tmp/policy
  env:
    CLEAN_ROOM_POLICY_BODY: ${{ secrets.CLEAN_ROOM_POLICY }}
- run: npx clean-room-guard --policy /tmp/policy
```

First-public-push checklist: run with `--walk` once (catches untracked files
you are about to `git add`), then the default tracked-files scan, then read
`git log --format='%an %ae'`; history is part of the publication too.

## The tests are the point

Every behavioural claim above is mapped to the test that enforces it in
[CLAIMS.md](CLAIMS.md). The load-bearing ones:

| Test | Claim |
| :-- | :-- |
| policy inside a scanned root is refused, from the library | the list itself is the leak, and the guard is not just in the CLI |
| --staged reads the index blob, not the worktree | staging a secret then cleaning the file cannot fool the hook |
| --staged from a subdirectory scans the whole staged set | a monorepo hook cannot miss the sibling package |
| an oversized file dirties the result, named | a file the scan could not examine is not clean |
| a NUL-bearing `notes.txt` is skipped and named, a text `data.bin` is scanned | the sniff is content, not extension |
| a UTF-16 file carrying a token is caught | the common skip class is scanned, not written off |
| scanning zero files is not clean | the worst failure is a reassuring exit 0 over nothing |
| an `allow:` with no value is an error | a one-character typo must not silently disable the scan |
| a token in a path is a finding, and the report masks it | paths publish too, and the report is still safe to share |
| two secrets on one line are two findings | under-reporting is the dangerous direction |
| a malformed regex exits 2, not 1 | a policy typo is not a leak; the contract has to hold |
| empty policy is an error | an empty policy proves nothing; silence is not cleanliness |
| allow rules skip known noise | false positives get an explicit, visible escape hatch |
