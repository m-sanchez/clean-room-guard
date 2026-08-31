# clean-room-guard

Pre-publication scanning with a private local denylist that never enters the
repository.

[More tools](https://github.com/m-sanchez) · [Working rules](https://miguelsanchez.co.uk/ethics)

Before a tree goes public, scan it for the tokens that must not travel with
it: organisation names, internal hostnames, ticket prefixes, machine paths.
The twist most scanners miss: **the list of forbidden tokens is itself the
most sensitive file involved**. clean-room-guard is built around that fact.

- The policy file is required and lives outside the scanned tree — the tool
  **refuses to run** if the policy sits inside any scanned root. The list
  cannot ship with the tree it guards, by construction.
- Reports are **redacted by default**: `match src/config.ts:14:8 rule#3`.
  A leak report you can paste into an issue without republishing the leak.
  `--show` reveals tokens when you are somewhere safe.
- Inside a git work tree it scans **what git tracks** — the set that would
  actually publish — not whatever happens to be on disk. `--staged` scans
  the index instead, for pre-commit use.

## Run

```bash
npm install
npm test

# scan the current repo against ~/.clean-room-policy
node bin/clean-room-guard.mjs

# explicit policy and roots; reveal matched tokens
node bin/clean-room-guard.mjs ./dist --policy ~/policies/acme.txt --show
```

Exit codes: `0` clean · `1` matches found · `2` usage or policy error.
A missing or empty policy is an error, never a clean pass.

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
`git log --format='%an %ae'` — history is part of the publication too.

## The tests are the point

| Test | Claim |
| :-- | :-- |
| policy inside a scanned root is refused | the list itself is the leak; the tool will not let you publish it |
| redacted report omits the token | the report is safe to share by default |
| empty policy is an error | an empty policy proves nothing; silence is not cleanliness |
| binaries skipped by content sniff, not extension | a renamed binary does not crash or lie |
| allow rules skip known noise | false positives get an explicit, visible escape hatch |
