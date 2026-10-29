# dsh-mattpocock-skills

Every skill from [mattpocock/skills][upstream] — 38 of them — as a DeepSeek
Harness plugin bundle. The skill bodies are **vendored from upstream by a
script**, never copied by hand, so updating means re-running one command.

**English** | [简体中文](README-zh.md)

| | |
|---|---|
| Upstream | [github.com/mattpocock/skills][upstream] (MIT) |
| Skills | 38 across `engineering`, `productivity`, `misc`, `in-progress` |
| DSH | `>=0.2.0-rc.1 <0.3.0-0` |
| Dependencies | none at runtime |

## Who needs this package

**You already installed Matt Pocock's skills as a Codex plugin, and you do not
want a second copy in the global `~/.agents/skills` just so DSH can see them.**

That is the case this package exists for. Codex's plugin route —

```bash
codex plugin marketplace add mattpocock/skills
codex plugin add mattpocock-skills@mattpocock
```

— keeps the skills inside Codex's own plugin storage and updates them at
startup, and a DeepSeek Harness session does not read that storage. Harness
only discovers local skills under these roots (the provider's defaults; it also
accepts a `customSkillDirs` root between the project and user rows):

| Rank | Root |
|---|---|
| 100 | `<project>/.dsh/skills` |
| 200 | `<project>/.agents/skills` |
| 400 | `~/.dsh/skills` |
| 500 | `~/.agents/skills` |

So the obvious fix is to copy the skills into `~/.agents/skills` — either by
hand, or with upstream's file-copy installer (`npx skills@latest add
mattpocock/skills`). That works, and DSH then discovers them like any other
local skill. But now the same 38 skills live in two places, each with its own
update path, and the two drift the moment only one of them is refreshed.

This package is the alternative: one bundle that vendors upstream by script, so
DSH gets the skills without a second copy in any skills root. Nothing is
written to `~/.agents/skills`, `~/.dsh/skills`, or `<project>/.agents/skills`.

More precisely, it also fits you if:

- **You keep agent config global and project-agnostic.** No per-repo setup, no
  `.agents/skills` committed into each repository.
- **You want the skills pinned and auditable.** `skills/PROVENANCE.json` records the exact
  upstream commit in `PROVENANCE.json`, instead of tracking a moving global
  directory.
- **You want the user-invoked / model-invoked split preserved.** The 23 skills
  upstream marks `disable-model-invocation` stay reachable only by `/name`.

### When you do not need it

If those same skills already sit in `~/.agents/skills` or `<project>/.agents/skills`,
DSH already discovers them — installing this bundle adds nothing. Those roots
outrank this one (rank 500 and 200 versus 600), so with a copy present every
same-named skill here is shadowed, and the local copy wins silently. Pick one
location, not both:

- **Pick `~/.agents/skills`** if you want one copy shared by every agent tool
  on the machine, and you are happy updating it by hand or with
  `npx skills@latest update`.
- **Pick this bundle** if you want DSH to receive the skills as a versioned,
  re-syncable package while Codex keeps its own plugin-managed copy.

## Install

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-mattpocock-skills
```

`dsh plugin` forwards the rest of its arguments to `pnpm` inside the profile
directory, saves the dependency, and links the package. Then select the bundle
once, which writes it into `dsh.profile.bundles`:

```bash
# or enable it from the Web UI: Plugins → Bundles → mattpocock-skills
```

Restart the Harness after installing or replacing the package: a new module
generation is only loaded on boot. Once running, all 38 skills appear in the
session catalog and are reachable with the `skill` tool or as `/name` commands.

To uninstall:

```bash
dsh plugin --profile <profile> remove dsh-mattpocock-skills
```

## Keeping up with upstream

```bash
node scripts/sync-skills.mjs               # track the default branch
node scripts/sync-skills.mjs --ref v1.3.1  # pin a tag, branch, or commit
node scripts/sync-skills.mjs --check       # exit 1 when skills/ is stale (CI gate)
pnpm sync                                  # same as the first command
```

A Node.js script with no dependencies, so it runs anywhere `node` and `git` do.
It clones upstream into a temporary directory, copies each skill directory
(bodies plus their `references/`, `scripts/`, `assets/`, and `agents/`
siblings), and rewrites `skills/` only after the staged copy
is complete — an interrupted run leaves the previous tree usable, and the
temporary directory is removed even when the run fails.

It records only provenance — the upstream repository, commit, commit date,
version, and skill count — in `skills/PROVENANCE.json`, a file
of under 500 bytes. The skill list is deliberately not duplicated there: the
directory tree already is the list, so discovery reads the tree and the two
cannot disagree. Nothing else is derived twice.

| Flags / environment | Meaning |
|---|---|
| `--ref <ref>` | Tag, branch, or commit to vendor instead of the default branch |
| `--repo <url>` | Clone from a fork instead of upstream |
| `--check` | Vendor nothing; compare the staged tree with `skills/` and exit 1 when they differ |
| `MATTPOCOCK_SKILLS_REF` | Default for `--ref` |
| `MATTPOCOCK_SKILLS_REPO` | Default for `--repo` |

Exit codes: `0` success or up to date, `1` failure or stale, `2` bad arguments.
`--check` is the CI gate: it still clones (so it sees new upstream commits) but
never writes to `skills/`.

### Automated daily sync

[`.github/workflows/sync-skills.yml`](.github/workflows/sync-skills.yml) runs the
sync **once a day at 00:00 UTC**, so a fork that never touches the repository
still tracks upstream.

The job is deliberately quiet: it runs `--check` first, and if upstream has not
moved it exits having committed nothing. When upstream *has* moved, it syncs,
runs all 44 checks, and only then commits `skills/` and pushes — so a malformed
upstream `SKILL.md` fails the job instead of reaching the branch.

```
Check upstream → (no change) done
               → (changed) sync → verify 44 checks → commit skills/ → push
```

Design details worth knowing:

- **No timestamp-only commits.** The sync compares content digests with
  `syncedAt` normalized out, so a day with no upstream change produces no
  commit. `syncedAt` therefore records when the content last *changed*, not
  when it was last checked.
- **Only `skills/` is committed.** The job stages `git add -- skills`, so a
  stray write elsewhere in the runner cannot ride along.
- **Commits are unattributed by design.** They are authored by
  `github-actions[bot]`, and `GITHUB_TOKEN` commits do not trigger further
  workflows — this commit is data, not a release.
- **Runs are serialized** by a `concurrency` group, so two runs cannot race for
  the same branch.
- **Manual runs** are enabled with `workflow_dispatch`, so you can exercise it
  from the Actions tab before trusting the schedule.

Scheduled workflows only fire on the default branch, and GitHub runs them on a
best-effort basis — expect a few minutes of drift, not a precise midnight tick.
To pause the automation, disable the workflow in the Actions tab or delete the
file.

A running Harness picks up a re-sync without a restart: the provider watches
the vendored tree and calls `invalidate()` on the skill registry, which appends
a replacement catalog on the next model step. Only a change to `lib/` needs a
restart.

## Verify

```bash
node scripts/verify.mjs
```

44 checks covering the frontmatter reader, the registry's candidate and
definition validators re-stated from `@deepseek-ai/dsh-skill`, every vendored
skill's catalog entry and loaded body, the bundle patch/locales/icon, the sync
script's Node-only dependency surface and its exit codes, and the row config
schema. Exit code 1 on any failure.

## How it works

The bundle's patch inserts one Host row. That row registers a **skill
provider** on `ctx.skills` — the same seam `dsh-skill-filesystem` and
`dsh-skill-office` use — over the vendored tree:

```
skills/<name>/SKILL.md     -> one catalog entry
skills/<name>/references/  -> the skill's resource base
```

One directory per skill, flat. Upstream's bucket layer (`engineering`,
`productivity`, …) is dropped: it is their organising device, nothing in the
harness consumes it, and every skill name is unique across buckets.

Nothing is written to `.dsh/skills`, `.agents/skills`, or `~/.dsh/skills`, so
the plugin cannot collide with a project's own skills and needs no per-project
setup. Vendored skills carry rank `600`, the standard rank for packaged
providers, so a project-local skill of the same name still wins.

Frontmatter is parsed by a small YAML-subset reader (`lib/frontmatter.js`)
rather than a YAML library, which keeps the package dependency-free. It handles
plain, single-quoted, and double-quoted scalars, `|` and `>` block scalars, and
nested mappings such as `metadata.credits`. Anything outside that subset —
flow collections, anchors, tags — throws, and the affected skill is skipped
with a warning instead of silently loading a truncated description.

### Invocation

Upstream marks 23 of the 38 skills `disable-model-invocation: true`: the model
must not reach them on its own, only the human typing `/name`. The provider
maps that to the registry's `modelInvocable: false, userInvocable: true`, so
those skills stay out of the model's catalog and out of the `skill` tool, while
remaining invocable as `/ask-matt`, `/setup-matt-pocock-skills`, and so on. The
other 15 stay reachable by both surfaces.

### Configuration

The row needs no `config`. These fields are optional:

| Field | Default | Meaning |
|---|---|---|
| `skillRoot` | the vendored `skills/` tree | Directory holding one subdirectory per skill |
| `provenance` | the vendored `PROVENANCE.json` | Attribution source; `false` omits it |
| `watch` | `true` | Rebuild the catalog when `SKILL.md` files change |

Unknown keys are rejected rather than ignored, so a typo in `skillRoot` fails
activation loudly instead of quietly falling back to the vendored tree. Override
a row by restating the whole `config` mapping, since a matching patch override
replaces it instead of merging.

## What is and is not included

Included: every skill directory (`SKILL.md` plus its `references/`,
`scripts/`, `assets/`, and `agents/` siblings), and upstream's `LICENSE` so
attribution travels with the content.

Not included — deliberately, to keep the vendored tree to skills and their
licence: upstream's bucket `README.md`s, top-level `README.md`,
`.claude-plugin/plugin.json`, `.git`, CI workflows, `docs/`, `.agents/`, and
`.out-of-scope/`. `skills/deprecated/` is empty of skills and skipped.

Two upstream skills describe Claude Code specifics that DSH does not have:
`git-guardrails-claude-code` sets up Claude Code hooks, and `claude-handoff`
hands off to a Claude session. They are vendored verbatim and load normally,
but their instructions do not apply to this harness.

## Layout

```
cordis.patch.yml              bundle patch: one Host row
lib/index.js                  provider: discovery, loading, watching
lib/frontmatter.js            YAML-subset reader for SKILL.md frontmatter
lib/config.js                 row config schema and validation
locale/{en,zh}.json           Plugin Manager display metadata
icon.svg                      bundle icon
scripts/sync-skills.mjs        vendors the upstream tree (Node, no deps)
scripts/verify.mjs            contract checks
.github/workflows/sync-skills.yml  daily upstream sync (00:00 UTC)
skills/                       generated by sync-skills.mjs — do not edit
```

`skills/` is generated. Edit it and the next sync overwrites the change; to
change a skill, fork upstream and point `MATTPOCOCK_SKILLS_REPO` at the fork.

## Licence

The plugin code is MIT. The vendored skills are MIT, © Matt Pocock, and the
upstream `LICENSE` travels with them in `skills/LICENSE`. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

[upstream]: https://github.com/mattpocock/skills
