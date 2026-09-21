# tools/jev — local preprocessing in front of the TypeSafe System One API

**This directory is ours, not TypeSafe's.** The official skill is the unmodified
copy under `.claude/skills/typesafe-ai/` (see `PROVENANCE.md`). Nothing here is an
official feature, and nothing here should be described as one.

Its job is narrow: shrink what the agent has to read. Large candidate sets and long
logs get collapsed **locally** first; Jev is asked only to make a semantic choice over
what survives, and code — never the model — resolves the answer back to a real file,
line and excerpt.

## Default is OFF

With no environment set, every entry point answers locally and opens no socket.

| Variable | Effect |
| --- | --- |
| `JEV_ENABLED=1` | master switch; without it everything is local |
| `JEV_ALLOW_REAL_API=1` | additionally required before the real endpoint is contacted |
| `TYPESAFE_API_KEY` | required for the real endpoint; value never logged or printed |
| `JEV_MOCK_BASE_URL` | tests only; **must** be `http://127.0.0.1:<port>` |
| `JEV_LEDGER_PATH` | budget ledger; point several environments at one file to share a pot |
| `JEV_CACHE_PATH`, `JEV_ALLOWLIST_PATH`, `JEV_TIMEOUT_MS`, `JEV_REPO_ROOT` | overrides |

The real API is currently **off in this cloud environment on purpose**, and could not
be reached anyway: the egress policy returns 403 for `api.typesafe.ai`.

## Commands

```sh
node tools/jev/cli.mjs status                       # mode, caps, budget, allowlist
node tools/jev/cli.mjs find <regex> --question "…"  # pattern A: pick among candidates
node tools/jev/cli.mjs log <file> --question "…"    # pattern B: digest a long log
node tools/jev/cli.mjs review <base> [head] [--budget N]  # pattern C: pre-review narrowing
node tools/jev/cli.mjs allow <path>…                # add exact paths to the allowlist
node tools/jev/cli.mjs budget                       # spend snapshot
sh   tools/jev/test/run.sh                          # mock-HTTP suite (loopback only)
node tools/jev/bench.mjs [--mock]                   # measure against a local baseline
node tools/jev/measure.mjs [--mock]                 # A/B/C/cache arms, full input accounting
```

## When NOT to call Jev

Two gates, and either one keeps the work local:

- fewer than `minCandidatesForJev` (8) candidates or unpinned log groups, or
- less than `minBaselineBytesForJev` (4 KB) of material a plain read would cost.

The second gate exists because measurement demanded it: a 5-candidate search saved
15% for a full request. Small task, known file, short log → no call, every time.

## What may leave the machine

- Only content from **exact paths** listed in `allowlist.json`. No globs, no
  directories; `..`, absolute paths and `*` are rejected on entry.
- Never anything under `.git/`, `.jev/`, `node_modules/`, `.env*`, key material,
  `.private/`, `secrets/`, or Claude session/conversation directories.
- Every line matching a credential or PII rule is **dropped and counted**, and the
  serialized payload is re-scanned immediately before the socket; a hit throws
  rather than transmitting.
- The DTO is **path-free**: candidates are opaque ids (`c1`, `g1`). The id→path map
  never leaves this process.

## Budget

`jev-1.13.0`, input `$0.042/Mtok`, output free (confirmed 2026-09-22).

The development budget is **split by environment**, because no shared ledger exists
between them:

| Environment | Daily | Monthly | Note |
| --- | --- | --- | --- |
| Windows host / Codex helper | $0.08 | $4.00 | holds the key; real calls happen there |
| This Claude cloud container | $0.02 | $1.00 | enforced by `config.mjs` |

**These are independent caps, not a shared atomic pot.** Each side enforces only its
own numbers and neither can see the other's spend. Totals combine only if every
environment points `JEV_LEDGER_PATH` at one shared file, which is not possible across
the cloud/Windows boundary today — so do not describe this ledger as a shared budget.
Within one environment the ledger *is* atomic (file lock + atomic rename).

Also capped: 20 attempts/day, 100k reserved tokens/day (binds before the USD cap),
2 concurrent.

Every attempt — **including a retry after a 429 or a 5xx** — reserves before the
request goes out. A crash, or a response whose `usage` is missing or malformed,
settles at the reservation: never as free. The ledger is a lock-protected file
written by atomic rename.

**Sharing the pot.** Totals are only combined when every environment points
`JEV_LEDGER_PATH` at the same file. That is not possible between this cloud container
and the Windows host, so until it is, the allocation is explicit and separate:

| Environment | Allocation | Note |
| --- | --- | --- |
| Windows host (Codex helper) | full `$0.10/day` / `$5/month` | holds the key; real calls happen there |
| This cloud container | `$0.00` — real API OFF | mock only; also blocked by egress policy |

## Failure policy

| Situation | Behaviour |
| --- | --- |
| off, no key, budget refused | 0 retries, local result |
| 400/401/403/404/422 | 0 retries, local result |
| 429 / 5xx / timeout / connection | 1 retry, each attempt reserving budget, then local |
| model ≠ `jev-1.13.0` | rejected |
| unknown candidate, bad shape, out of range, confidence < 0.35 | rejected |
| response over 256 KB | rejected |

## Cache

Keyed on repository + HEAD + **working-tree dirty state** + the full content sent +
the questions + the resolved model + a config fingerprint, with a 24h TTL. Entries
that are expired, malformed, or carry a different model or config are rejected.

## What Jev is never asked to do

Free-form summarizing, design, code generation, deep root-cause reasoning, or
anything with execution rights. It returns a typed choice; code does the rest. No
string from a file or a model answer is ever passed to a shell — child processes are
spawned with fixed argument vectors only.

## Pre-review narrowing (`review`)

`review <base> [head]` narrows a large diff to what is worth reading first. Its
invariants matter more than its savings:

1. The **full inventory of every changed file** is always emitted. Narrowing
   decides what is READ, never what is LISTED.
2. Files not read in full land in `notReviewed` with `reviewed: false` and the
   exact `git diff` command to open them.
3. **A file Jev did not select is not safe and not reviewed.** Nothing in the
   output may say otherwise; a test asserts the word "safe" never appears.
4. Both old and new line numbers ride along on every retained line.
5. Risk markers — skipped/removed tests, suppressions, swallowed errors, exec,
   unresolved work, credential shapes — are pinned regardless of any score.
6. Counts of everything elided are reported (`pinnedTotals`, `linesElided`).

## Measuring, honestly

`measure.mjs` runs four arms over one input — **A** plain local review input,
**B** local preprocessing, **C** Jev preprocessing, **cache** reuse — and counts
the instruction, the body, the helper JSON **and the follow-up re-reads each arm
still forces**.

Three quantities are kept apart and never conflated:

| Quantity | Status |
| --- | --- |
| bytes | **measured** |
| tokens | **measured** only via `POST /v1/messages/count_tokens`; otherwise a labelled estimate |
| account quota | **not observable** from this environment — never reported |

`tiktoken` and friends are OpenAI tokenizers and are not used at any confidence
level. Without `ANTHROPIC_API_KEY` every token figure carries `tokensMeasured:
false` and names the estimator.

### Result on PR #1 (`tools/jev/measurements/`)

| Arm | Total bytes | Est. tokens | Jev calls | Cost | Evidence kept |
| --- | --- | --- | --- | --- | --- |
| A plain diff | 114,993 | ~35,565 | 0 | $0 | yes |
| B local only | 45,526 | ~14,279 | 0 | $0 | yes |
| C Jev | 45,269 | ~14,174 | 1 | $0.000080598 | yes |
| cache | 45,086 | ~14,117 | 0 | $0 | yes |

**Where the saving does NOT come from Jev.** B already captures 60.4% of the
reduction; C adds 0.2% (257 bytes) for a real request. On a 702-line build log the
helper cut 94.1% with **zero** Jev calls — local dedupe did all of it. Jev earns its
call only when many genuinely distinct semantic candidates remain after local
narrowing; on these two inputs it mostly did not.
