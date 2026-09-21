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

Use it to keep large material out of context:

```sh
node tools/jev/cli.mjs log <file> --question "…"     # long log  → pinned evidence + digest
node tools/jev/cli.mjs find <regex> --question "…"   # many hits → one file:line + excerpt
node tools/jev/cli.mjs review <base> [head]          # long diff → inventory + pinned + unread list
node tools/jev/cli.mjs status                        # mode, caps, budget, allowlist
```

- **Default is OFF** and the real API stays off here — `api.typesafe.ai` currently
  403s at the egress proxy. Everything still works locally; the tooling says which
  path it took.
- **Auth modes.** `JEV_AUTH_MODE=direct` (default) sends `x-api-key` and needs
  `TYPESAFE_API_KEY`. `JEV_AUTH_MODE=proxy` sends **no auth header**: a cloud
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

**Use `review` on your own work.** Before reporting on a diff of any size — your own
branch included — run `node tools/jev/cli.mjs review <base> HEAD` and work from its
`inventory`. Doing this on this repository's own PR is what surfaced an oversized
digest, 126 bogus findings from prose, and a mis-tiered risk model.

Then: always read the full `inventory` — it lists every changed file. Files in
`notReviewed` are **not reviewed**; a file Jev did not select says nothing about its
safety. Either open them with the printed command or raise `--budget`, and say
plainly in your report which files you did not read.

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
