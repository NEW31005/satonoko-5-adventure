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
node tools/jev/cli.mjs allow <path>…                # add exact paths to the allowlist
node tools/jev/cli.mjs budget                       # spend snapshot
sh   tools/jev/test/run.sh                          # mock-HTTP suite (loopback only)
node tools/jev/bench.mjs [--mock]                   # measure against a local baseline
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

`jev-1.13.0`, input `$0.042/Mtok`, output free (confirmed 2026-09-22). Caps:
`$0.10/day`, `$5.00/month`, 20 attempts/day, 100k reserved tokens/day, 2 concurrent.

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
