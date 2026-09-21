# CLAUDE.md

Operating notes for Claude Code in this repository.

## Project

`satonoko-5-adventure` — a Phaser 3 + TypeScript + Vite game, with Firebase
(Firestore) world ranking. Build: `npm ci && npm run build`.

## Scope boundary

The **SATONOKO Guide** product is being implemented in a separate working copy by
the Codex lead with No.6/No.7. Unless a task explicitly says otherwise, do not
change the app itself, authentication, game logic, publishing/deploy configuration,
or a pinned release candidate from this repository.

## Jev / TypeSafe preprocessing

The official TypeSafe skill is installed **unmodified** at
`.claude/skills/typesafe-ai/` (provenance and hashes: `tools/jev/PROVENANCE.md`).
Do not edit it. Our own guard rails live only in `tools/jev/` — see
`tools/jev/README.md`.

Use it for triage order and log dedupe — see the operating rule below for when it
is and is not the right tool:

```sh
node tools/jev/cli.mjs log <file> --question "…"     # long log  → pinned evidence + digest
node tools/jev/cli.mjs find <regex> --question "…"   # many hits → one file:line + excerpt
node tools/jev/cli.mjs review <base> [head]          # large diff → inventory + pinned + verificationReads
node tools/jev/cli.mjs status                        # mode, auth mode, caps, budget, allowlist
```

- **Default is OFF.** Everything works locally; the tooling says which path it took.
- **Real calls need `NODE_USE_ENV_PROXY=1`.** Node's `fetch` otherwise bypasses the
  agent proxy, which both enforces egress policy and attaches the cloud credential.
  The client refuses a real call without it rather than sending un-proxied.
- **Auth modes.** `JEV_AUTH_MODE=direct` (default) sends `Authorization: Bearer`
  (as the official SDK does) and needs `TYPESAFE_API_KEY`. `JEV_AUTH_MODE=proxy` sends **no auth header**: a cloud
  environment API credential makes Anthropic's agent proxy add
  `Authorization: Bearer` after the request leaves the VM, so no key is held here.
  `proxy` drops only the key requirement — every other gate still applies.
- **Do not reach for it for small work.** A known file, a short log, a handful of
  search hits: read them directly. Two gates enforce this (< 8 candidates, or
  < 4 KB of material), and a skipped call is the normal, correct outcome.
- Content leaves the machine only from **exact paths** in `tools/jev/allowlist.json`.
  Add one with `node tools/jev/cli.mjs allow <path>`.
- Jev returns a typed choice only. Summaries, design, code generation, root-cause
  reasoning and anything executable stay with you.

**Operating rule — when to preprocess, and when not to.**

The goal is to reduce Codex/Claude consumption, not to use Jev. Measured on this
repo: a *fully verified* review costs **33.9% MORE** input through the helper than
reading the diff directly, because the helper's JSON is overhead on top of opening
every file anyway.

So:

- **Reviewing a change completely → read `git diff` directly.** That is the default
  for any review where you intend to check every file. Do not add a helper pass on
  top of it, and never run both as a double read.
- **Use `review` only when you are NOT going to read everything**: a large candidate
  set where the question is *what to investigate first*. It buys triage order, not
  savings.
- **Use `log` for long logs**, where local dedupe does the real work — 94.1%
  measured, with zero Jev calls.
- **Small or already-understood input → read it directly.** The helper would only
  add its own JSON.

Its output is an **excerpt set, not a review**: `selectedExcerpts` are capped,
truncated and context-free and carry `reviewed: false`, `notSelected` files are not
shown at all, and `verificationReads` lists everything still to be opened in full —
selected files included. Always read the whole `inventory`, say plainly which files
you did not open, and never treat "Jev did not select it" as a safety signal.

**Numbers — keep four things apart:**
- bytes are **measured**; token figures are **estimates** unless `tokensMeasured:
  true` (needs `ANTHROPIC_API_KEY` for the official `count_tokens` endpoint);
  account quota is **not observable** here — never claim it.
- a cost from a mock run is **simulated**, not money spent. Only responses from
  `api.typesafe.ai` may be called real spend.
- **name the denominator**: a delta as a percentage of B is not the same number as
  the same delta in percentage points of A.
- **extraction input ≠ completed review.** Saving on what you read *first* is not
  saving on the whole review while files remain unread.

Before changing anything under `tools/jev/`, run `sh tools/jev/test/run.sh`
(mock HTTP, loopback only — it contacts no external service).

## Known state

Jev budget for this environment: $0.02/day, $1.00/month. The Windows/Codex side has
a separate $0.08/day, $4.00/month allocation — the two ledgers are independent, not
a shared pot.

`npm audit` reports 3 high-severity advisories in dev dependencies
(`nanoid`, `postcss`, `vite`). Not addressed here: the lockfile belongs to the
product working copy.
