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
| `JEV_AUTH_MODE` | `direct` (default) or `proxy` — see below |
| `TYPESAFE_API_KEY` | required in `direct` mode only; value never logged or printed |
| `JEV_MOCK_BASE_URL` | tests only; **must** be `http://127.0.0.1:<port>` |
| `NODE_USE_ENV_PROXY=1` | **required for any real call** when `HTTPS_PROXY` is set — see below |
| `JEV_MAX_RETRIES` | override retries (0..3, default 1); set `0` for a single-attempt run |
| `JEV_LEDGER_PATH` | budget ledger; point several environments at one file to share a pot |
| `JEV_CACHE_PATH`, `JEV_ALLOWLIST_PATH`, `JEV_TIMEOUT_MS`, `JEV_REPO_ROOT` | overrides |

The real API is currently **off in this cloud environment on purpose**, and could not
be reached anyway: the egress policy returns 403 for `api.typesafe.ai`.

## Authentication modes

| Mode | Who holds the key | What we send | Needs `TYPESAFE_API_KEY` |
| --- | --- | --- | --- |
| `direct` (default) | this process | `Authorization: Bearer <key>` | **yes** |
| `proxy` | the cloud environment | **nothing** | **no** |

In `proxy` mode a Claude Code cloud-environment **API credential** holds the key.
Anthropic's agent proxy attaches `Authorization: Bearer <key>` *after the request
has left the session VM*, so the value never reaches this process, its environment
variables, the commands it runs, or the agent. We therefore send **neither `Authorization` nor
`x-api-key`** — a test asserts that proxy mode withholds a key even when one is
present in the environment, because sending one would leak a credential we are not
supposed to hold.

The header in `direct` mode is `Authorization: Bearer`, read from the official
`@typesafe-ai/sdk` 0.6.0 build (`dist/index.mjs:581`). An earlier revision sent
`x-api-key`; that was a misreading of `KEY_HEADERS` (`dist/index.mjs:285-288`), which
is the set of header *names* whose values get masked in logs, not a header the SDK
sets. Bearer also matches the real `200` the Windows/Codex side observed.

`proxy` removes only the key requirement. Default-OFF, `JEV_ALLOW_REAL_API`, the
budget caps, the allowlist and every other gate apply unchanged, and the endpoint is
the same fixed official HTTPS URL.

### Cloud environment setup (values are registered by the account owner, never here)

Prepared for registration at [claude.ai/code](https://claude.ai/code) → edit the
**Default** environment → **API credentials** → **Add credential**:

| Field | Value |
| --- | --- |
| Credential type | `Bearer` (the default) |
| Name | `TypeSafe Jev (api.typesafe.ai)` |
| Allowed websites | `api.typesafe.ai` — exactly this host, no `*.` wildcard |
| Custom header → Name | `Authorization` |
| Custom header → Prefix | `Bearer` |
| Custom header → Value | the TypeSafe API key — **pasted by the account owner, never by Claude and never in this repository** |

Notes from the official docs: API credentials need an organization admin role and a
Pro or Max plan; the environment must already exist (the new-environment dialog does
not offer them); there is no edit, so changing hosts or value means delete and re-add;
the value cannot be viewed again after saving. A credential's allowed hosts are
reachable **even when the environment's network access level would not otherwise
allow them**, so this covers `api.typesafe.ai` on its own.

`docs.typesafe.ai` is **not** on the credential and still needs a separate egress
allowance if the skill's live-doc reads are wanted. It currently returns 403.

### The agent proxy must be in the path

Node's built-in `fetch` does **not** read `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`
is set *before the process starts* (setting it from inside is too late — undici reads
it at startup). Bypassing the agent proxy is not merely a connectivity problem: the
proxy enforces the egress policy and, in `proxy` auth mode, is what attaches the
credential. A request that skips it leaves outside policy and unauthenticated.

`resolveMode` therefore **refuses** a real call when `HTTPS_PROXY` is set and
`NODE_USE_ENV_PROXY` is not. Run real calls as:

```sh
NODE_USE_ENV_PROXY=1 node tools/jev/cli.mjs …
```

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

## Operating rule

The objective is fewer Codex/Claude tokens, **not** more Jev calls. The measurement
below shows a fully verified review costs **33.9% more** input through the helper
than reading the diff directly, so:

| Situation | Do this |
| --- | --- |
| Reviewing a change completely | **`git diff` directly.** No helper pass on top, and never both |
| Large candidate set, you will *not* read it all | `review` — for investigation **order** only |
| Long log | `log` — local dedupe does the work (94.1% measured, 0 Jev calls) |
| Small or already-understood input | read it directly |

The helper buys triage order on material you were never going to read in full. It
does not make a complete review cheaper, and it must not become a mandatory second
read of a diff you are already reading.

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

### Results (`tools/jev/measurements/`, 23 files, 176,511 B raw diff)

**Cost basis: SIMULATED.** Every response came from a loopback mock replaying a
fixture `usage`. No billed TypeSafe request has ever succeeded from this cloud
environment, so no dollar figure here is money spent. Token figures are estimates
(`tokensMeasured: false`). Real account quota is not observable and is not reported.

| Arm | Extraction input | Est. tokens | Full-verification input | Files needing verification | Jev calls |
| --- | --- | --- | --- | --- | --- |
| A plain diff | 178,168 | ~55,008 | 178,168 | 0 / 23 | 0 |
| B local only | 66,086 | ~20,673 | 238,569 | 23 / 23 | 0 |
| C Jev | 77,713 | ~24,262 | 238,807 | 23 / 23 | 1 |
| cache | 77,530 | ~24,205 | 238,624 | 23 / 23 | 0 |

**Extraction input** — what it costs to decide what to read first. B saves 62.91% of
A; C saves 56.38% of A.

**Full-verification input** — what it costs to actually check the change. Every file
lands in `verificationReads`, **selected ones included**, because their excerpts
elide lines, truncate lines and drop context. An excerpt is not a reading of a file.
Here the helper is a **net loss: B costs 33.90% MORE than A, and C 34.03% more.**
Recorded as measured. The helper buys triage order on a large diff; it does not
reduce the cost of a complete review.

**Jev's own effect (simulated).** C is **11,627 bytes worse than B** at extraction —
**−17.59% measured against B**, or **−6.53 percentage points measured against A**
(same bytes, different denominators) — because the call promoted a larger file into
the excerpt budget, for a simulated $0.000080598. On a 702-line build log the helper
cut 94.1% with **zero** Jev calls: local dedupe did all of it.
