# Provenance of the installed official skill

The official skill under `.claude/skills/typesafe-ai/` is an **unmodified** copy.
Nothing in this repository edits it; our own code lives only under `tools/jev/`.

## Source

| Field | Value |
| --- | --- |
| Repository | https://github.com/typesafe-ai/skills |
| Commit | `65a39f393687675ce170e6094757de20370365b9` |
| Tag at that commit | `v0.5.7` |
| Retrieved | 2026-09-21 (shallow clone over HTTPS) |
| Installed as | whole-directory placement of `skills/typesafe-ai/` |
| Plugin install | **not used** -- exactly one install method, no double install |

## SHA256 of every file in the upstream commit

```
7040ea575b7549d7db06cce21ebe479471930953eaede01d8cd9ed81511abd11  .claude-plugin/marketplace.json
3d4e3433dc040fde349deaf773a4a4b070b3aa5ce34b3f321b170d2409a9fa5a  .claude-plugin/plugin.json
835f233f1d6ed84a9b9a351aba0689b47644a4137d6316911fc7957bde523b02  LICENSE
799ce1dc39dc1cb98977f930610bf693a26d1a78e5912b860014447d97390282  README.md
835f233f1d6ed84a9b9a351aba0689b47644a4137d6316911fc7957bde523b02  skills/typesafe-ai/LICENSE
71ea90d7906c6554c4f4c460ef7361b2d26f59116ccdae986dc6d997b9389f52  skills/typesafe-ai/SKILL.md
```

## SHA256 of what is installed here

```
71ea90d7906c6554c4f4c460ef7361b2d26f59116ccdae986dc6d997b9389f52  .claude/skills/typesafe-ai/SKILL.md
835f233f1d6ed84a9b9a351aba0689b47644a4137d6316911fc7957bde523b02  .claude/skills/typesafe-ai/LICENSE
```

`skills/typesafe-ai/SKILL.md` hashes to
`71ea90d7906c6554c4f4c460ef7361b2d26f59116ccdae986dc6d997b9389f52`, matching the
value recorded independently on the Codex side. The directory is LICENSE + SKILL.md,
two files, also as recorded there.

## Verify at any time

```sh
sha256sum .claude/skills/typesafe-ai/SKILL.md
# expect 71ea90d7906c6554c4f4c460ef7361b2d26f59116ccdae986dc6d997b9389f52
```

## Why directory placement and not the plugin

Both are official. `claude plugin marketplace add typesafe-ai/skills` installs into
`~/.claude/plugins/`, which in this cloud container is **ephemeral** -- it is wiped when
the container is reclaimed, leaves nothing reviewable in the diff, and would also write
to the user-level plugin configuration we were asked not to change. Committing the
directory keeps the skill loaded for every future session in this repository, puts the
exact bytes under review, and adds no session-start network dependency.

## API contract source

`SKILL.md` defers the API contract to https://docs.typesafe.ai, which this environment's
egress policy blocks (403 at the proxy; see README.md). The wire contract implemented in
`tools/jev/` was therefore taken from the official TypeScript SDK instead:

| Field | Value |
| --- | --- |
| Package | `@typesafe-ai/sdk@0.6.0` (npm, reachable) |
| Tarball SHA256 | `ccd94517c911c58ed5284b15838a001393e304ea3b784f6e8fb5a79f6365378e` |
| Repository | https://github.com/typesafe-ai/typesafe-sdk-js |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` |
| Auth header | `Authorization: Bearer <key>` (`dist/index.mjs:581`) |
| Env vars | `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` |
| Default model | `jev-latest` (we pin `jev-1.13.0` instead) |
| Request | `{ model, state, questions: { name: Choice|Noul|Score } }` |
| Response | `{ model, answers, usage: { input_tokens, output_tokens } }` |

The SDK is **not** vendored or installed; only its published build was read to confirm
the shapes.

**Correction.** An earlier revision of this file recorded the auth header as
`x-api-key`, from a bare string grep of the bundle. That was wrong: `x-api-key` appears
there only inside `KEY_HEADERS` (`dist/index.mjs:285-288`), the set of header names whose
values are masked when logging. The header the SDK actually sets is
`Authorization: Bearer ${apiKey}` at `dist/index.mjs:581`, which also matches the real
`200` the Windows/Codex side observed. `tools/jev/lib/client.mjs` sends Bearer in
`direct` mode and neither header in `proxy` mode.
