# CLAIMS

Every externally falsifiable claim this package makes - in `README.md` and
in the `description` field of `package.json` - mapped to the executable
test that enforces it. If a row here has no test, the claim does not belong
in the README.

Test names are given as `file::test name` and are the exact names printed
by `npm test`. Rows naming `.github/workflows/test.yml::install proof` are
enforced in CI against the **packed tarball** rather than the source tree,
because the claim is about what an adopter installs.

## The policy is the most sensitive file

| Claim | Where stated | Enforced by |
| :-- | :-- | :-- |
| A private local denylist "never enters the repository" | `package.json` description, README lead | `test/guard.test.mjs::a policy inside a scanned root is refused` · `test/cli.test.mjs::a policy inside the scanned root exits 2` |
| The policy file is required | README bullet 1, exit-code paragraph | `test/cli.test.mjs::a missing policy exits 2, never a clean pass` |
| The tool refuses to run if the policy sits inside **any** scanned root | README bullet 1 | `test/guard.test.mjs::a policy inside a scanned root is refused` · `test/guard.test.mjs::--staged refuses a policy anywhere in the repository, not just under the scanned root` |
| The guards live in `scan()`, not the CLI | README, last bullet | `test/guard.test.mjs::the guards live in scan(): a library caller cannot bypass them` |
| `parsePolicy()` refuses the typos that would turn the scanner into a no-op | README, last bullet | `test/guard.test.mjs::an empty allow: value is a usage error, not a licence to skip every file` · `test/guard.test.mjs::a malformed regex rule is a usage error, not a crash into the match exit code` |

## The report is safe to share

| Claim | Where stated | Enforced by |
| :-- | :-- | :-- |
| Reports are redacted by default (`match src/config.ts:14:8 rule#3`) | README bullet 2 | `test/guard.test.mjs::report is redacted by default and explicit with --show` · `test/cli.test.mjs::a match exits 1 with a redacted report` |
| `--show` reveals the tokens | README bullet 2 | `test/guard.test.mjs::report is redacted by default and explicit with --show` |
| A token **in the path** is masked to a same-width run of `*` | README bullets 2-3 | `test/guard.test.mjs::a token in a file PATH is a finding, and the redacted report does not republish it` · `test/guard.test.mjs::a content finding inside a leaky path is redacted in the path too` |
| No output stream carries the token when redacted | README bullet 2 | `test/cli.test.mjs::a token in a path exits 1 and no output stream echoes the token` · `.github/workflows/test.yml::install proof` (case 1, against a real planted token) |

## What gets scanned

| Claim | Where stated | Enforced by |
| :-- | :-- | :-- |
| File **paths** are scanned as content | README bullet 3 | `test/guard.test.mjs::a token in a file PATH is a finding, and the redacted report does not republish it` |
| Path findings are visibly distinct (`path-match`, no line number) | README bullet 3 | `test/guard.test.mjs::a token in a file PATH is a finding, and the redacted report does not republish it` (asserts `kind: 'path'`, `line: 0`) · `test/cli.test.mjs::a token in a path exits 1 and no output stream echoes the token` |
| Inside a git work tree the default scan is **what git tracks** | README bullet 4 | `test/guard.test.mjs::inside a git work tree the default scan is what git tracks` |
| `--walk` catches untracked files you are about to `git add` | README bullet 4, checklist | `test/guard.test.mjs::inside a git work tree the default scan is what git tracks` |
| `--staged` scans the **index blobs**, so cleaning the worktree cannot fool the hook | README bullet 4 | `test/guard.test.mjs::--staged reads the index, not the working tree` |
| `--staged` scans the **whole index**, so a hook fired from a subdirectory cannot miss a sibling package | README bullet 4 | `test/guard.test.mjs::--staged from a subdirectory scans the whole staged set, repo-relative` · `test/guard.test.mjs::--staged from a subdirectory still scans the staged set` |
| The documented pre-commit recipe fails a commit whose sibling package leaks | README, Recipes | `test/cli.test.mjs::the documented pre-commit hook fails a commit whose sibling package leaks` |
| Every rule reports every match; two secrets on one line are two findings | README claim table | `test/guard.test.mjs::two secrets on one line are two findings, not one` |

## Nothing unexamined counts as clean

| Claim | Where stated | Enforced by |
| :-- | :-- | :-- |
| Files over the size cap are **named** and fail unless `--allow-skip` | README bullet 5 | `test/guard.test.mjs::an oversized file is named and dirties the result unless skips are allowed` |
| `--max-bytes` changes the cap | README bullet 5 | `test/guard.test.mjs::an oversized file is named and dirties the result unless skips are allowed` (cap set to 20 bytes) · `test/cli.test.mjs::a flag with a missing value is a usage error, never a silent fallback` (rejects a non-numeric value) |
| Binary files are **named** and fail unless `--allow-skip` | README bullet 5 | `test/guard.test.mjs::binaries are detected by content, NAMED, and dirty the result` · `test/cli.test.mjs::an unscanned binary is named in the output and exits 1` |
| The binary decision is a content sniff, not an extension | README claim table | `test/guard.test.mjs::binaries are detected by content, NAMED, and dirty the result` (a NUL-bearing `notes.txt` is skipped; a text `data.bin` is scanned) |
| A UTF-16 BOM is decoded and scanned as text | README bullet 5 | `test/guard.test.mjs::UTF-16 files are decoded and scanned, not dropped as binary` (LE and BE) |
| A run that examined **no files at all** fails | README bullet 5, exit codes | `test/guard.test.mjs::scanning zero files is never clean` · `test/cli.test.mjs::scanning zero files exits 1, never a clean pass` · `.github/workflows/test.yml::install proof` (case 5) |
| `--allow-empty` accepts a legitimately empty root | README, exit codes | `test/guard.test.mjs::scanning zero files is never clean` · `test/cli.test.mjs::scanning zero files exits 1, never a clean pass` |
| A staged file under the cap is scanned however large | implied by the size cap | `test/guard.test.mjs::--staged scans a blob larger than the child-process buffer, not just the size cap` |
| A staged blob over the cap is skipped **without being read** | README, Recipes (why the cap exists) | `test/guard.test.mjs::--staged never reads a blob it is going to skip for size` |

## The exit-code contract

| Claim | Where stated | Enforced by |
| :-- | :-- | :-- |
| `0` clean | README, exit codes | `test/guard.test.mjs::clean text yields no matches` · `test/cli.test.mjs::a clean tree exits 0` · `.github/workflows/test.yml::install proof` (case 2) |
| `1` matches found | README, exit codes | `test/cli.test.mjs::a match exits 1 with a redacted report` · `.github/workflows/test.yml::install proof` (case 1) |
| `1` unscanned files present | README, exit codes | `test/cli.test.mjs::an unscanned binary is named in the output and exits 1` |
| `1` nothing examined at all | README, exit codes | `test/cli.test.mjs::scanning zero files exits 1, never a clean pass` · `.github/workflows/test.yml::install proof` (case 5) |
| `2` missing policy | README, exit codes | `test/cli.test.mjs::a missing policy exits 2, never a clean pass` · `.github/workflows/test.yml::install proof` (case 3) |
| `2` empty policy | README, exit codes | `test/cli.test.mjs::an empty policy exits 2` |
| `2` `allow:` line with no value | README, exit codes and policy format | `test/cli.test.mjs::an empty allow: value in the policy exits 2` |
| `2` malformed regex rule | README, exit codes | `test/cli.test.mjs::a malformed regex in the policy exits 2, not the code reserved for matches` · `.github/workflows/test.yml::install proof` (case 4) |
| `2` policy inside a scanned root | README bullet 1 | `test/cli.test.mjs::a policy inside the scanned root exits 2` |
| A flag with a missing value is a usage error, never a silent fallback | README, exit codes | `test/cli.test.mjs::a flag with a missing value is a usage error, never a silent fallback` |

## Policy format

| Claim | Where stated | Enforced by |
| :-- | :-- | :-- |
| One rule per line; `#` comments | README, Policy format | `test/guard.test.mjs::policy parses literals, regexes, comments, and allow rules` |
| `/slashes/i` is a regex | README, Policy format | `test/guard.test.mjs::regex rules match` · `test/guard.test.mjs::policy parses literals, regexes, comments, and allow rules` |
| Anything else is a case-insensitive literal | README, Policy format | `test/guard.test.mjs::literals match case-insensitively and report position` |
| `allow:<substring>` excludes paths containing the substring | README, Policy format | `test/guard.test.mjs::scan walks a tree and honours allow rules` |
| `allow:` takes precedence over path matching | README, Policy format | `test/guard.test.mjs::allow rules take precedence over path matches` |
| `allow:` with nothing after it is rejected | README, Policy format | `test/guard.test.mjs::an empty allow: value is a usage error, not a licence to skip every file` |

## Packaging

| Claim | Where stated | Enforced by |
| :-- | :-- | :-- |
| Zero dependencies | README badge | `test/package.test.mjs::the package has no runtime dependencies` |
| Runs anywhere node 18+ does | README, Install; `engines` | `.github/workflows/test.yml` (matrix `node: [18, 22, 24]`) |
| The packed tarball installs and imports | README, Install | `.github/workflows/test.yml::install proof` |
| The packed tarball catches a planted token without echoing it | README, Install | `.github/workflows/test.yml::install proof` (case 1) |
| `clean-room-guard` is on the path via `npx` after install | README, Install | `.github/workflows/test.yml::install proof` (every case invokes `npx clean-room-guard`) |
| The published tarball contains what `bin` and `exports` point at | implied by Install | `test/package.test.mjs::the published tarball carries what the entry points name` |
| The git-tag install line names an installable version of this package | README, Install | `test/package.test.mjs::the git-tag install line in the README names the version being published` |

## Measurements, not assertions

One README row is a measurement rather than a claim a test can pass or
fail: the pre-commit hook latency table. Wall-clock numbers are properties
of a machine, so asserting them in CI would produce a flaky test rather
than a guarantee.

| Claim | Where stated | Backed by |
| :-- | :-- | :-- |
| Hook latency at 100 / 1,000 / 10,000 staged files | README, Recipes | `bench/staged-latency.mjs`, run as `npm run bench`. The README states the machine, node and git versions the published numbers came from, and `--impl` re-runs the same harness against an older `src/guard.mjs` to reproduce the comparison column. |
