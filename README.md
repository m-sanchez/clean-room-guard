# clean-room-guard

![Node](https://img.shields.io/badge/node-%3E%3D18-5FA04E?logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-B45309)
[![CI](https://github.com/m-sanchez/clean-room-guard/actions/workflows/test.yml/badge.svg)](https://github.com/m-sanchez/clean-room-guard/actions/workflows/test.yml)
![Exit codes](https://img.shields.io/badge/exit_codes-0%2F1%2F2-6E6E6E)
![License](https://img.shields.io/badge/license-MIT-6E6E6E)

Pre-publication scanning with a private local denylist that never enters the
repository.

[More tools](https://github.com/m-sanchez) · [Working rules](https://miguelsanchez.co.uk/ethics)

Before a tree goes public, scan it for the tokens that must not travel with
it: organisation names, internal hostnames, ticket prefixes, machine paths.
The twist most scanners miss: **the list of forbidden tokens is itself the
most sensitive file involved**. clean-room-guard is built around that fact.

- The policy file is required and lives outside the scanned tree: the tool
  **refuses to run** if the policy sits inside any scanned root. The list
  cannot ship with the tree it guards, by construction.
- Reports are **redacted by default**: `match src/config.ts:14:8 rule#3`.
  A leak report you can paste into an issue without republishing the leak.
  `--show` reveals tokens when you are somewhere safe.
- Inside a git work tree it scans **what git tracks**, the set that would
  actually publish, not whatever happens to be on disk. `--staged` scans
  **the index blobs themselves** (`git show :<path>`), so staging a secret
  and then cleaning the working copy cannot fool a pre-commit hook, and
  running from a subdirectory cannot silently scan zero files.
- **A file the scan could not examine is not clean.** Files over the size
  cap (5 MB default, `--max-bytes` to change) are named in the output and
  fail the scan unless you pass `--allow-skip` explicitly. Binary files
  are skipped by a NUL-sniff of the first 8 KB - a heuristic, documented
  as one: UTF-16 and NUL-free binaries are scanned as text.
- **The guards live in the library.** `scan()` itself refuses a policy
  inside a scanned root and an empty policy; the CLI is a thin wrapper,
  not the enforcement point.

## Install

```bash
npm install -D github:m-sanchez/clean-room-guard#v2.0.0
```

Not yet on npm; the pinned git tag is the supported install (plain
JavaScript, runs anywhere node 18+ does) and CI proves the packed tarball
installs, imports, and catches a planted token. After install the
`clean-room-guard` command is on your path via `npx`.

```bash
# scan the current repo against ~/.clean-room-policy
npx clean-room-guard

# explicit policy and roots; reveal matched tokens
npx clean-room-guard ./dist --policy ~/policies/acme.txt --show
```

Exit codes: `0` clean · `1` matches found or unscanned files present ·
`2` usage or policy error. A missing or empty policy is an error, never a
clean pass, and a flag with a missing value is a usage error, never a
silent fallback.

## Policy format

One rule per line. `#` comments. `/slashes/i` for a regex; anything else is
a case-insensitive literal. `allow:<substring>` excludes paths containing
the substring (lockfiles full of random base64, vendored noise).

```text
# ~/.clean-room-policy - never committed anywhere
projectnova
hq-internal.example
/TICKET-\d+/
allow:package-lock.json
```

## Recipes

Pre-commit hook (`.git/hooks/pre-commit`):

```bash
#!/bin/sh
exec clean-room-guard --staged
```

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

| Test | Claim |
| :-- | :-- |
| policy inside a scanned root is refused, from the library | the list itself is the leak, and the guard is not just in the CLI |
| --staged reads the index blob, not the worktree | staging a secret then cleaning the file cannot fool the hook |
| --staged from a subdirectory scans the staged set | no silent zero-file pass |
| an oversized file dirties the result, named | a file the scan could not examine is not clean |
| two secrets on one line are two findings | under-reporting is the dangerous direction |
| redacted report omits the token | the report is safe to share by default |
| empty policy is an error | an empty policy proves nothing; silence is not cleanliness |
| binaries skipped by content sniff, not extension | a renamed binary does not crash or lie |
| allow rules skip known noise | false positives get an explicit, visible escape hatch |
